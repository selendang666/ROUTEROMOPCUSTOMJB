import path from "node:path";
import fs from "node:fs";

export const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");

export function redactUrl(value: string): string {
  if (!value) return value;
  try {
    const url = new URL(value);
    if (url.password) url.password = "***";
    if (url.username) url.username = "***";
    for (const key of [...url.searchParams.keys()]) {
      if (/secret|token|password|key/i.test(key)) {
        url.searchParams.set(key, "***");
      }
    }
    return url.toString();
  } catch {
    return value.replace(/:\/\/([^@\n]+)@/g, "://***:***@");
  }
}

export function redact(value: string | undefined): string {
  if (!value) return "(not set)";
  if (value.length <= 8) return "***";
  return redactUrl(value);
}

export function isPostgresUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const u = new URL(value);
    return u.protocol === "postgres:" || u.protocol === "postgresql:";
  } catch {
    return false;
  }
}

export function validateDatabaseUrl(url: string | undefined): { valid: boolean; reason?: string } {
  if (!url || url.trim() === "") {
    return { valid: false, reason: "DATABASE_URL is not set. Set it to a PostgreSQL connection string, e.g. postgresql://user:***@127.0.0.1:5432/ohmyomop_router" };
  }
  if (!isPostgresUrl(url)) {
    return { valid: false, reason: `DATABASE_URL must be a PostgreSQL URL (postgres:// or postgresql://). Got: ${redactUrl(url)}` };
  }
  try {
    const u = new URL(url);
    if (!u.hostname) return { valid: false, reason: "DATABASE_URL missing hostname" };
    return { valid: true };
  } catch (e) {
    return { valid: false, reason: `DATABASE_URL is not a valid URL: ${(e as Error).message}` };
  }
}

export function validateRedisUrl(url: string | undefined): { valid: boolean; reason?: string } {
  if (!url || url.trim() === "") return { valid: true };
  try {
    const u = new URL(url);
    if (u.protocol !== "redis:" && u.protocol !== "rediss:") {
      return { valid: false, reason: `REDIS_URL must be redis:// or rediss://. Got: ${redactUrl(url)}` };
    }
    return { valid: true };
  } catch (e) {
    return { valid: false, reason: `REDIS_URL invalid: ${(e as Error).message}` };
  }
}

export type SpawnResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

export async function spawnWithTimeout(
  args: readonly string[],
  opts: {
    cwd?: string;
    env?: Record<string, string | undefined>;
    timeoutMs?: number;
    stdin?: "ignore" | "pipe" | "inherit";
  } = {},
): Promise<SpawnResult> {
  const cwd = opts.cwd ?? REPO_ROOT;
  const timeoutMs = opts.timeoutMs ?? 15_000;

  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([...args] as [string, ...string[]], {
      cwd,
      env: opts.env as Record<string, string>,
      stdin: opts.stdin ?? "ignore",
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    } as Parameters<typeof Bun.spawn>[1]);
  } catch (e) {
    return {
      exitCode: 127,
      stdout: "",
      stderr: e instanceof Error ? e.message : String(e),
      timedOut: false,
    };
  }

  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<SpawnResult>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill();
        setTimeout(() => {
          try {
            proc.kill(9);
          } catch {}
        }, 2_000);
      } catch {}
      resolve({
        exitCode: 124,
        stdout: "",
        stderr: `timed out after ${timeoutMs}ms: ${args.join(" ")}`,
        timedOut: true,
      });
    }, timeoutMs);
  });

  const resultPromise = (async (): Promise<SpawnResult> => {
    const out = proc.stdout as unknown as ReadableStream<Uint8Array>;
    const err = proc.stderr as unknown as ReadableStream<Uint8Array>;
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(out).text().catch(() => ""),
      new Response(err).text().catch(() => ""),
      proc.exited,
    ]);
    void timedOut;
    return { exitCode, stdout, stderr, timedOut: false };
  })().catch((e): SpawnResult => ({
    exitCode: 127,
    stdout: "",
    stderr: e instanceof Error ? e.message : String(e),
    timedOut: false,
  }));

  const result = await Promise.race([resultPromise, timeoutPromise]);
  clearTimeout(timer);
  if (result.timedOut) {
    try {
      await proc.exited.catch(() => {});
    } catch {}
  }
  return result;
}

export async function detectDockerCompose(timeoutMs = 8_000): Promise<{ args: string[]; label: string } | null> {
  try {
    const probe1 = await spawnWithTimeout(["docker", "compose", "version"], { timeoutMs });
    if (probe1.exitCode === 0) {
      return { args: ["docker", "compose"], label: "docker compose" };
    }
    const probe2 = await spawnWithTimeout(["docker-compose", "version"], { timeoutMs });
    if (probe2.exitCode === 0) {
      return { args: ["docker-compose"], label: "docker-compose" };
    }
    return null;
  } catch {
    return null;
  }
}

export async function checkPostgres(url: string, timeoutMs = 8_000): Promise<{ ok: boolean; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // Runtime-selected Bun SQL — dynamic import justified: Bun native SQL not available in all Node runtimes
    const bunMod = await import("bun");
    const SQLCtor = (bunMod as unknown as { SQL: new (url: string) => { close: () => Promise<void> } }).SQL;
    if (!SQLCtor) throw new Error("Bun SQL not available");
    const sql: unknown = new SQLCtor(url);
    // Use tagged template (safe, no string interpolation) — avoids unsafe() fallback.
    void controller.signal;
    const tag = sql as unknown as (s: TemplateStringsArray) => Promise<unknown>;
    await tag`SELECT 1 as ok`;
    try {
      await (sql as { close: () => Promise<void> }).close();
    } catch {}
    return { ok: true };
  } catch (e) {
    if ((e as Error).name === "AbortError") return { ok: false, error: `timed out after ${timeoutMs}ms` };
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

export async function checkRedis(url: string, timeoutMs = 5_000): Promise<{ ok: boolean; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // Runtime-selected Bun RedisClient — dynamic import justified: optional Redis
    const bunMod = await import("bun");
    const RedisCtor = (bunMod as unknown as { RedisClient: new (url: string) => unknown }).RedisClient;
    if (!RedisCtor) throw new Error("Bun RedisClient not available");
    const client = new RedisCtor(url) as { ping?: () => Promise<unknown>; send?: (cmd: string, args: unknown[]) => Promise<unknown>; close?: () => Promise<void> };
    void controller.signal;
    if (typeof client.ping === "function") {
      await client.ping();
    } else if (typeof client.send === "function") {
      await client.send("PING", []);
    } else {
      throw new Error("RedisClient ping not available");
    }
    try {
      await client.close?.();
    } catch {}
    return { ok: true };
  } catch (e) {
    if ((e as Error).name === "AbortError") return { ok: false, error: `timed out after ${timeoutMs}ms` };
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

export function migrationEntryExists(): boolean {
  const candidates = [
    path.join(REPO_ROOT, "src", "persistence", "migrate.ts"),
    path.join(REPO_ROOT, "src", "persistence", "migrate.js"),
  ];
  return candidates.some((p) => fs.existsSync(p));
}

export function migrationsDirExists(): boolean {
  return fs.existsSync(path.join(REPO_ROOT, "drizzle", "pg", "meta", "_journal.json"));
}

export function composeFileExists(): boolean {
  return (
    fs.existsSync(path.join(REPO_ROOT, "docker-compose.yml")) ||
    fs.existsSync(path.join(REPO_ROOT, "compose.yml")) ||
    fs.existsSync(path.join(REPO_ROOT, "compose.yaml"))
  );
}

export function printHeader(title: string): void {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
  console.log("─".repeat(title.length));
}

export function logOk(msg: string): void {
  console.log(`\x1b[32m✓\x1b[0m ${msg}`);
}
export function logWarn(msg: string): void {
  console.log(`\x1b[33m!\x1b[0m ${msg}`);
}
export function logFail(msg: string): void {
  console.log(`\x1b[31m✗\x1b[0m ${msg}`);
}
export function logInfo(msg: string): void {
  console.log(`  ${msg}`);
}

// ── OS-aware helpers ───────────────────────────────────────────────────────

export const isWindows = process.platform === "win32";
export const isMacOS = process.platform === "darwin";
export const isLinux = process.platform === "linux";

export function currentPlatformLabel(): string {
  if (isWindows) return "windows";
  if (isMacOS) return "macos";
  return "linux";
}

/**
 * Returns actionable local PostgreSQL hints for the current OS.
 * Kept in _shared so infra, doctor, and setup share the same messaging.
 */
export function localPostgresHints(databaseUrl?: string): string[] {
  const urlHint = databaseUrl ? `  DATABASE_URL=${redactUrl(databaseUrl)}` : "";
  const base = [
    "Verify PostgreSQL is running on the host/port in DATABASE_URL.",
    "Ensure the database exists: createdb ohmyomop_router (or via pgAdmin).",
    "Check firewall / listen_addresses in postgresql.conf.",
  ];
  if (isWindows) {
    return [
      "Laragon: Menu → PostgreSQL → Start (or Start All), check port 5432 not blocked.",
      "Windows service:  net start postgresql-x64-16  (adjust version)",
      "Or install Docker Desktop and run  bun run infra:up  for containerized Postgres.",
      ...base,
      urlHint,
    ].filter(Boolean) as string[];
  }
  if (isMacOS) {
    return [
      "macOS (Homebrew):  brew services start postgresql@16  (or postgresql@15)",
      "Check:  brew services list | grep postgres  and  lsof -i :5432",
      "Or install Docker Desktop and run  bun run infra:up",
      ...base,
      urlHint,
    ].filter(Boolean) as string[];
  }
  return [
    "Linux:  sudo systemctl start postgresql  (or  sudo service postgresql start)",
    "Check:  systemctl status postgresql  and  pg_isready -h 127.0.0.1 -p 5432",
    "Or install Docker and run  bun run infra:up",
    ...base,
    urlHint,
  ].filter(Boolean) as string[];
}

/**
 * Try to auto-start a local PostgreSQL instance when Docker is unavailable.
 * Best-effort only: never throws, returns whether a start was attempted.
 * Windows/Laragon is not auto-started (GUI service); macOS tries brew, Linux tries systemctl without sudo prompt.
 */
export async function tryAutoStartLocalPostgres(): Promise<{ attempted: boolean; label?: string; ok?: boolean; error?: string }> {
  if (isMacOS) {
    // Best effort: brew services start postgresql@16 (also try @15, @14)
    for (const svc of ["postgresql@16", "postgresql@15", "postgresql@14", "postgresql"]) {
      const r = await spawnWithTimeout(["brew", "services", "start", svc], { timeoutMs: 8_000 });
      if (r.exitCode === 0) return { attempted: true, label: `brew services start ${svc}`, ok: true };
    }
    return { attempted: true, label: "brew services start postgresql@16", ok: false, error: "brew start failed" };
  }
  if (isLinux) {
    // Try systemd without sudo first (user service), then hint
    const r = await spawnWithTimeout(["systemctl", "--user", "start", "postgresql"], { timeoutMs: 5_000 });
    if (r.exitCode === 0) return { attempted: true, label: "systemctl --user start postgresql", ok: true };
    return { attempted: false, label: "sudo systemctl start postgresql (requires sudo — not auto-run)" };
  }
  // Windows: Laragon/Postgres service requires manual start
  return { attempted: false, label: "Laragon Start All (manual)" };
}

// ── Doctor early-warning helpers ─────────────────────────────────────────

import os from "node:os";

export interface ResourceSnapshot {
  readonly freeGb: number;
  readonly totalGb: number;
  readonly freeMemGb: number;
  readonly totalMemGb: number;
  readonly loadAvg: readonly number[];
  readonly cpus: number;
}

export function getResourceSnapshot(): ResourceSnapshot {
  let freeGb = -1;
  let totalGb = -1;
  try {
    const stat = fs.statfsSync(REPO_ROOT) as unknown as { bavail: number; bsize: number; blocks: number };
    if (typeof stat.bavail === "number" && typeof stat.bsize === "number") {
      freeGb = (stat.bavail * stat.bsize) / (1024 ** 3);
      totalGb = (stat.blocks * stat.bsize) / (1024 ** 3);
    }
  } catch {}
  const totalMemGb = os.totalmem() / (1024 ** 3);
  const freeMemGb = os.freemem() / (1024 ** 3);
  return { freeGb, totalGb, freeMemGb, totalMemGb, loadAvg: os.loadavg(), cpus: os.cpus().length };
}

export function formatGb(value: number): string {
  if (value < 0) return "unknown";
  return `${value.toFixed(2)} GB`;
}

export async function isPortFree(port: number, host = "127.0.0.1", timeoutMs = 1200): Promise<{ free: boolean; error?: string }> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      try { socket.destroy(); } catch {}
      resolve({ free: true });
    }, timeoutMs);
    let socket: import("node:net").Socket;
    try {
      const net = require("node:net") as typeof import("node:net");
      socket = net.createConnection({ port, host }, () => {
        clearTimeout(timer);
        try { socket.destroy(); } catch {}
        resolve({ free: false });
      });
      socket.on("error", () => {
        clearTimeout(timer);
        resolve({ free: true });
      });
    } catch (e) {
      clearTimeout(timer);
      resolve({ free: true, error: e instanceof Error ? e.message : String(e) });
    }
  });
}

export async function checkPostgresDeep(url: string): Promise<{ ok: boolean; version?: string; maxConnections?: string; error?: string }> {
  try {
    const bunMod = await import("bun");
    const SQLCtor = (bunMod as unknown as { SQL: new (opts: { url: string }) => { unsafe: (q: string) => Promise<unknown[]>; close: () => Promise<void> } }).SQL;
    if (!SQLCtor) return { ok: false, error: "Bun SQL not available" };
    const sql = new SQLCtor({ url });
    try {
      const vRows = await sql.unsafe("SHOW server_version");
      const version = (vRows[0] as Record<string, string> | undefined)?.server_version ?? (vRows[0] as Record<string, string> | undefined)?.serverVersion ?? String(vRows[0] ?? "");
      const cRows = await sql.unsafe("SHOW max_connections");
      const maxConnections = (cRows[0] as Record<string, string> | undefined)?.max_connections ?? String(cRows[0] ?? "");
      return { ok: true, version: version ? String(version) : undefined, maxConnections: maxConnections ? String(maxConnections) : undefined };
    } finally {
      try { await sql.close(); } catch {}
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}


