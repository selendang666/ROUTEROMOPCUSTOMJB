#!/usr/bin/env bun
/**
 * dev-all — start backend + dashboard concurrently (cross-platform)
 *
 * Usage:
 *   bun run dev:all          # enak, satu command
 *   bun run scripts/dev-all.ts
 *
 * Backend:  bun run --watch src/main.ts  (PORT dari .env, default 3000)
 * Dashboard: bun run --cwd dashboard dev (vite, default 5173)
 * Log diprefix [backend] / [dashboard], Ctrl+C matikan keduanya.
 *
 * Windows juga ada PowerShell: ./scripts/windows/dev.ps1
 */
import { spawn } from "node:child_process";

const PREFIX = { backend: "\x1b[36m[backend]\x1b[0m", dashboard: "\x1b[35m[dashboard]\x1b[0m" };

function spawnPrefixed(name: keyof typeof PREFIX, cmd: string, args: string[], cwd = "."): ReturnType<typeof spawn> {
  const p = spawn(cmd, args, { cwd, stdio: ["inherit", "pipe", "pipe"], shell: process.platform === "win32" });
  const tag = PREFIX[name];
  p.stdout?.on("data", (d: Buffer) => { for (const line of String(d).split("\n")) if (line.trim()) process.stdout.write(`${tag} ${line}\n`); });
  p.stderr?.on("data", (d: Buffer) => { for (const line of String(d).split("\n")) if (line.trim()) process.stderr.write(`${tag} ${line}\n`); });
  p.on("exit", (code, sig) => {
    const reason = code !== null ? `exit ${code}` : `signal ${sig}`;
    console.error(`${tag} ${reason} — dev-all akan stop`);
    // Kill sibling
    for (const q of procs) if (q !== p) try { q.kill("SIGTERM"); } catch {}
    if (code !== 0 && code !== null) process.exitCode = code ?? 1;
  });
  return p;
}

const procs: ReturnType<typeof spawn>[] = [];

procs.push(spawnPrefixed("backend", "bun", ["run", "--watch", "src/main.ts"]));
procs.push(spawnPrefixed("dashboard", "bun", ["run", "--cwd", "dashboard", "dev"]));

console.log("\n▶ dev:all — backend (bun --watch) + dashboard (vite) — Ctrl+C untuk stop\n");
console.log("  backend   → http://localhost:3000  (atau PORT di .env)");
console.log("  dashboard → http://localhost:5173\n");

function shutdown(signal: NodeJS.Signals) {
  console.log(`\n▶ ${signal} — stop...`);
  for (const p of procs) try { p.kill(signal); } catch {}
  setTimeout(() => process.exit(0), 800).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGHUP", () => shutdown("SIGHUP"));

// Keep alive until both exit
await Promise.all(procs.map((p) => new Promise<void>((r) => p.on("exit", () => r()))));
