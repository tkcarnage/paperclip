import { createHash } from "node:crypto";
import os from "node:os";
import type { AdapterModel } from "@paperclipai/adapter-utils";
import {
  asString,
  ensurePathInEnv,
  runChildProcess,
} from "@paperclipai/adapter-utils/server-utils";

const MODELS_CACHE_TTL_MS = 300_000;
const MODELS_DISCOVERY_TIMEOUT_MS = 60_000;

// Stable cwd prevents per-worktree cache misses; model discovery doesn't use cwd.
const DISCOVERY_CWD = "/paperclip/workspace/jinri";

// Models injected when the matching API key is present but opencode doesn't
// auto-discover the provider (covers MiniMax and ZAI coding-plan providers,
// see paperclipai/paperclip#1934).
const ENV_KEYED_MODELS: Array<{ envKey: string; models: AdapterModel[] }> = [
  {
    envKey: "MINIMAX_API_KEY",
    models: [{ id: "minimax-coding-plan/MiniMax-M2.7", label: "MiniMax M2.7 (coding-plan)" }],
  },
  {
    envKey: "ZHIPU_API_KEY",
    models: [{ id: "zai-coding-plan/glm-5.1", label: "ZAI GLM-5.1 (coding-plan)" }],
  },
];

function resolveOpenCodeCommand(input: unknown): string {
  const envOverride =
    typeof process.env.PAPERCLIP_OPENCODE_COMMAND === "string" &&
    process.env.PAPERCLIP_OPENCODE_COMMAND.trim().length > 0
      ? process.env.PAPERCLIP_OPENCODE_COMMAND.trim()
      : "opencode";
  return asString(input, envOverride);
}

const discoveryCache = new Map<string, { expiresAt: number; models: AdapterModel[] }>();
const VOLATILE_ENV_KEY_PREFIXES = ["PAPERCLIP_", "npm_", "NPM_"] as const;
// USERPROFILE volatile so Windows env differences don't create spurious cache misses
const VOLATILE_ENV_KEY_EXACT = new Set(["PWD", "OLDPWD", "SHLVL", "_", "TERM_SESSION_ID", "HOME", "USERPROFILE"]);

function dedupeModels(models: AdapterModel[]): AdapterModel[] {
  const seen = new Set<string>();
  const deduped: AdapterModel[] = [];
  for (const model of models) {
    const id = model.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    deduped.push({ id, label: model.label.trim() || id });
  }
  return deduped;
}

function sortModels(models: AdapterModel[]): AdapterModel[] {
  return [...models].sort((a, b) =>
    a.id.localeCompare(b.id, "en", { numeric: true, sensitivity: "base" }),
  );
}

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function parseModelsOutput(stdout: string): AdapterModel[] {
  const parsed: AdapterModel[] = [];
  // Strip ANSI escape sequences before parsing — opencode may colorize output
  // (fixes paperclipai/paperclip#3128 where color codes corrupted model IDs)
  const cleanStdout = stdout.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
  for (const raw of cleanStdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    // Find first token containing a slash — handles list markers ("•", "-", etc.)
    const token = line.split(/\s+/).find((t) => t.includes("/"));
    if (!token) continue;
    const match = token.match(/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_.-]+)/);
    if (!match) continue;
    const provider = match[1];
    const model = match[2];
    if (!provider || !model) continue;
    parsed.push({ id: `${provider}/${model}`, label: `${provider}/${model}` });
  }
  return dedupeModels(parsed);
}

function normalizeEnv(input: unknown): Record<string, string> {
  const envInput = typeof input === "object" && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(envInput)) {
    if (typeof value === "string") env[key] = value;
  }
  return env;
}

function isVolatileEnvKey(key: string): boolean {
  if (VOLATILE_ENV_KEY_EXACT.has(key)) return true;
  return VOLATILE_ENV_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function hashValue(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function discoveryCacheKey(command: string, env: Record<string, string>) {
  const envKey = Object.entries(env)
    .filter(([key]) => !isVolatileEnvKey(key))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${hashValue(value)}`)
    .join("\n");
  // cwd intentionally omitted — discovery uses DISCOVERY_CWD and is env-driven.
  return `${command}\n${envKey}`;
}

function pruneExpiredDiscoveryCache(now: number) {
  for (const [key, value] of discoveryCache.entries()) {
    if (value.expiresAt <= now) discoveryCache.delete(key);
  }
}

function injectEnvKeyedModels(
  discovered: AdapterModel[],
  runtimeEnv: Record<string, string>,
): AdapterModel[] {
  const extra: AdapterModel[] = [];
  for (const { envKey, models } of ENV_KEYED_MODELS) {
    if (runtimeEnv[envKey] || process.env[envKey]) {
      extra.push(...models);
    }
  }
  return dedupeModels([...discovered, ...extra]);
}

export async function discoverOpenCodeModels(input: {
  command?: unknown;
  cwd?: unknown;
  env?: unknown;
} = {}): Promise<AdapterModel[]> {
  const command = resolveOpenCodeCommand(input.command);
  const env = normalizeEnv(input.env);
  // Ensure HOME/USERPROFILE points to the actual running user's home directory.
  // When started via `runuser -u <user>`, HOME may reflect the parent process.
  let resolvedHome: string | undefined;
  try {
    resolvedHome = os.userInfo().homedir || undefined;
  } catch {
    // os.userInfo() throws a SystemError when the UID has no /etc/passwd entry.
  }
  const homeDir =
    (resolvedHome && resolvedHome.trim().length > 0 ? resolvedHome : undefined) ??
    process.env.HOME ??
    process.env.USERPROFILE;
  const homeEnv =
    homeDir && homeDir.trim().length > 0
      ? { HOME: homeDir, ...(process.platform === "win32" ? { USERPROFILE: homeDir } : {}) }
      : {};

  // Do NOT set OPENCODE_DISABLE_PROJECT_CONFIG — that flag suppresses all
  // env-var-based provider discovery (ZAI, MiniMax, etc.), leaving only
  // file-auth providers (GitHub Copilot OAuth) visible.
  const runtimeEnv = normalizeEnv(ensurePathInEnv({ ...process.env, ...env, ...homeEnv }));

  const result = await runChildProcess(
    `opencode-models-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    command,
    ["models"],
    {
      cwd: DISCOVERY_CWD,
      env: runtimeEnv,
      timeoutSec: MODELS_DISCOVERY_TIMEOUT_MS / 1000,
      graceSec: 3,
      onLog: async () => {},
    },
  );

  if (result.timedOut) {
    throw new Error(`\`opencode models\` timed out after ${MODELS_DISCOVERY_TIMEOUT_MS / 1000}s.`);
  }
  if ((result.exitCode ?? 1) !== 0) {
    const detail = firstNonEmptyLine(result.stderr) || firstNonEmptyLine(result.stdout);
    throw new Error(detail ? `\`opencode models\` failed: ${detail}` : "`opencode models` failed.");
  }

  const discovered = sortModels(parseModelsOutput(result.stdout));
  return sortModels(injectEnvKeyedModels(discovered, runtimeEnv));
}

export async function discoverOpenCodeModelsCached(input: {
  command?: unknown;
  cwd?: unknown;
  env?: unknown;
} = {}): Promise<AdapterModel[]> {
  const command = resolveOpenCodeCommand(input.command);
  const env = normalizeEnv(input.env);
  const key = discoveryCacheKey(command, env);
  const now = Date.now();
  pruneExpiredDiscoveryCache(now);
  const cached = discoveryCache.get(key);
  if (cached && cached.expiresAt > now) return cached.models;

  const models = await discoverOpenCodeModels({ command, env });
  discoveryCache.set(key, { expiresAt: now + MODELS_CACHE_TTL_MS, models });
  return models;
}

export async function ensureOpenCodeModelConfiguredAndAvailable(input: {
  model?: unknown;
  command?: unknown;
  cwd?: unknown;
  env?: unknown;
}): Promise<AdapterModel[]> {
  const model = asString(input.model, "").trim();
  if (!model) {
    throw new Error("OpenCode requires `adapterConfig.model` in provider/model format.");
  }

  let models = await discoverOpenCodeModelsCached({
    command: input.command,
    cwd: input.cwd,
    env: input.env,
  });

  // Retry once on miss — `opencode models` loads providers asynchronously and
  // can return a partial list on first call (paperclipai/paperclip#3602).
  if (models.length > 0 && !models.some((entry) => entry.id === model)) {
    const key = discoveryCacheKey(
      resolveOpenCodeCommand(input.command),
      normalizeEnv(input.env),
    );
    discoveryCache.delete(key);
    models = await discoverOpenCodeModels({
      command: input.command,
      cwd: input.cwd,
      env: input.env,
    });
    if (models.length > 0) {
      discoveryCache.set(key, { expiresAt: Date.now() + MODELS_CACHE_TTL_MS, models });
    }
  }

  if (models.length === 0) {
    throw new Error("OpenCode returned no models. Run `opencode models` and verify provider auth.");
  }

  if (!models.some((entry) => entry.id === model)) {
    const sample = models.slice(0, 12).map((entry) => entry.id).join(", ");
    throw new Error(
      `Configured OpenCode model is unavailable: ${model}. Available models: ${sample}${models.length > 12 ? ", ..." : ""}`,
    );
  }

  return models;
}

export async function listOpenCodeModels(): Promise<AdapterModel[]> {
  try {
    return await discoverOpenCodeModelsCached();
  } catch {
    return [];
  }
}

export function resetOpenCodeModelsCacheForTests() {
  discoveryCache.clear();
}
