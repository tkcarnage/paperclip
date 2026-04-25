import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";

export interface JinriWorkspaceConfig {
  repoPath: string;
  worktreesDir: string;
  db: {
    host: string;
    port: number;
    user: string;
    password: string;
    template: string;
  };
  api: {
    command: string[];
    portBase: number;
    health: string;
    timeoutSec: number;
  };
}

export interface JinriWorkspaceResult {
  cwd: string;
  databaseUrl: string;
  apiPort: number;
  webPort: number;
  apiUrl: string;
  isNew: boolean;
}

export function parseJinriWorkspaceConfig(config: Record<string, unknown>): JinriWorkspaceConfig | null {
  const raw = config.jinriWorkspace;
  if (!raw || typeof raw !== "object") return null;
  const w = raw as Record<string, unknown>;
  const repoPath = typeof w.repoPath === "string" ? w.repoPath.trim() : "";
  if (!repoPath) return null;
  const db = (typeof w.db === "object" && w.db !== null ? w.db : {}) as Record<string, unknown>;
  const api = (typeof w.api === "object" && w.api !== null ? w.api : {}) as Record<string, unknown>;
  return {
    repoPath,
    worktreesDir:
      typeof w.worktreesDir === "string"
        ? w.worktreesDir
        : path.join(path.dirname(repoPath), `${path.basename(repoPath)}-worktrees`),
    db: {
      host:     typeof db.host     === "string" ? db.host     : "localhost",
      port:     typeof db.port     === "number" ? db.port     : 5433,
      user:     typeof db.user     === "string" ? db.user     : "jinri",
      password: typeof db.password === "string" ? db.password : "jinri",
      template: typeof db.template === "string" ? db.template : "jinri_template",
    },
    api: {
      command:    Array.isArray(api.command)
        ? (api.command as unknown[]).map(String)
        : ["bun", "run", "src/server/index.ts"],
      portBase:   typeof api.portBase   === "number" ? api.portBase   : 3100,
      health:     typeof api.health     === "string" ? api.health     : "/health",
      timeoutSec: typeof api.timeoutSec === "number" ? api.timeoutSec : 30,
    },
  };
}

/**
 * Extract issue number from identifiers like "THE-283" → 283.
 * Returns null for UUIDs or unrecognised formats.
 */
function parseIssueNum(id: string): number | null {
  const m = id.match(/(\d+)$/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  // Sanity cap: real issue numbers are small; UUID trailing segments are large hex
  return !isNaN(n) && n > 0 && n < 5_000 ? n : null;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function checkApiHealth(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${port}/health`, { timeout: 2000 }, (res) => {
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitForHealth(port: number, timeoutSec: number): Promise<boolean> {
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    if (await checkApiHealth(port)) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

/**
 * Provision a per-issue dev environment:
 *  1. Git worktree off main (idempotent — reuse if exists, skipped if existingWorktreePath provided)
 *  2. Database cloned from template (idempotent)
 *  3. Drizzle migrations applied
 *  4. Hono API started and health-checked
 *
 * Pass existingWorktreePath when the Paperclip server has already created the worktree
 * (via executionWorkspacePolicy.workspaceStrategy.type="git_worktree"). In that case
 * git worktree creation is skipped and only DB + API provisioning runs.
 *
 * Returns the cwd (worktree path) and env vars to inject into the agent.
 */
export async function provisionJinriWorkspace(
  issueIdentifier: string,
  cfg: JinriWorkspaceConfig,
  onLog: (level: "stdout" | "stderr", msg: string) => Promise<void>,
  existingWorktreePath?: string,
): Promise<JinriWorkspaceResult> {
  const issueNum = parseIssueNum(issueIdentifier);
  if (!issueNum) {
    throw new Error(`Cannot derive issue number from identifier "${issueIdentifier}"`);
  }

  const branchName   = `issue-${issueNum}`;
  const worktreePath = existingWorktreePath || path.join(cfg.worktreesDir, branchName);
  const dbName       = `jinri_${issueNum}`;
  const { host, port: dbPort, user, password, template } = cfg.db;
  const databaseUrl  = `postgres://${user}:${password}@${host}:${dbPort}/${dbName}`;
  const apiPort      = cfg.api.portBase + issueNum;
  const webPort      = 4100 + issueNum;
  const apiUrl       = `http://localhost:${apiPort}`;
  const isNew        = !existingWorktreePath && !(await pathExists(worktreePath));

  // ── 1. Git worktree ──────────────────────────────────────────────────────────
  if (existingWorktreePath) {
    await onLog("stdout", `[workspace] Using server-provisioned worktree at ${worktreePath}\n`);
  } else if (isNew) {
    await onLog("stdout", `[workspace] Creating worktree ${worktreePath} on branch ${branchName}\n`);
    await fs.mkdir(cfg.worktreesDir, { recursive: true });
    try {
      execFileSync("git", ["-C", cfg.repoPath, "fetch", "origin", "main", "--quiet"], { stdio: "pipe" });
      execFileSync(
        "git",
        ["-C", cfg.repoPath, "worktree", "add", "-b", branchName, worktreePath, "origin/main"],
        { stdio: "pipe" },
      );
    } catch {
      // Branch may already exist — attach to it; if not, create from HEAD
      try {
        execFileSync(
          "git",
          ["-C", cfg.repoPath, "worktree", "add", worktreePath, branchName],
          { stdio: "pipe" },
        );
      } catch {
        execFileSync(
          "git",
          ["-C", cfg.repoPath, "worktree", "add", "-b", branchName, worktreePath, "HEAD"],
          { stdio: "pipe" },
        );
      }
    }
  } else {
    await onLog("stdout", `[workspace] Reusing worktree at ${worktreePath}\n`);
  }

  // ── 2. Database ──────────────────────────────────────────────────────────────
  if (isNew || existingWorktreePath) {
    await onLog("stdout", `[workspace] Cloning database ${template} → ${dbName}\n`);
    try {
      execFileSync(
        "psql",
        ["-h", host, "-p", String(dbPort), "-U", user, "-d", "postgres",
          "-c", `CREATE DATABASE "${dbName}" TEMPLATE "${template}";`],
        { stdio: "pipe", env: { ...process.env, PGPASSWORD: password } },
      );
    } catch {
      await onLog("stdout", `[workspace] Database ${dbName} already exists — skipping clone\n`);
    }
  }

  // ── 3. Migrations ────────────────────────────────────────────────────────────
  await onLog("stdout", `[workspace] Running migrations in ${worktreePath}\n`);
  try {
    execFileSync("bunx", ["drizzle-kit", "migrate"], {
      cwd: worktreePath,
      stdio: "pipe",
      env: { ...process.env, DATABASE_URL: databaseUrl },
    });
  } catch {
    await onLog("stdout", `[workspace] No pending migrations\n`);
  }

  // ── 4. API server ────────────────────────────────────────────────────────────
  if (!(await checkApiHealth(apiPort))) {
    await onLog("stdout", `[workspace] Starting API on port ${apiPort}\n`);
    const [cmd, ...args] = cfg.api.command;
    const proc = spawn(cmd, args, {
      cwd: worktreePath,
      env: { ...process.env, DATABASE_URL: databaseUrl, API_PORT: String(apiPort) },
      detached: true,
      stdio: "ignore",
    });
    proc.unref();
    const healthy = await waitForHealth(apiPort, cfg.api.timeoutSec);
    await onLog(
      "stdout",
      healthy
        ? `[workspace] API healthy at ${apiUrl}\n`
        : `[workspace] WARNING: API did not start — check /tmp/jinri-${issueNum}-api.log\n`,
    );
  } else {
    await onLog("stdout", `[workspace] API already healthy at ${apiUrl}\n`);
  }

  return { cwd: worktreePath, databaseUrl, apiPort, webPort, apiUrl, isNew };
}
