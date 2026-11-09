#!/usr/bin/env bun
/**
 * setup — Oh My Omop - Router cross-OS initializer (single entrypoint)
 *
 * Replaces split setup flows (package.json chain + windows/setup.ps1) with one Bun-native flow:
 *  1) Ensure Bun + .env (copy from .env.example if missing)
 *  2) Detect Docker vs local (via detectDockerCompose)
 *  3) Run infra:up (Docker or local PG) + db:migrate + doctor (all via Bun.spawn, no Bash)
 *
 * Usage:
 *   bun run setup        # cross-OS (Windows/macOS/Linux)
 *   bun run setup:win    # alias
 *   bun run setup:mac    # alias
 *   bun run setup:linux  # alias
 *   bun run scripts/setup.ts --help
 */
import path from "node:path";
import fs from "node:fs";
import {
  REPO_ROOT,
  spawnWithTimeout,
  printHeader,
  logOk,
  logWarn,
  logFail,
  logInfo,
  currentPlatformLabel,
} from "./dev/_shared.ts";

function usage(): void {
  console.log(`Usage: bun run setup [options]

Options:
  --help, -h   Show this help
  --check      Dry-run checks only (no infra up/migrate)

What it does:
  1) Ensures .env exists (copies .env.example if missing)
  2) Runs infra:up (Docker if available, else local PostgreSQL — Win Laragon / mac brew / linux systemd)
  3) Runs db:migrate
  4) Runs doctor

Cross-OS: Bun.spawn arrays + node:path, no Bash/grep/sed. Works on Windows/macOS/Linux.
`);
}

async function ensureEnv(): Promise<void> {
  const envPath = path.join(REPO_ROOT, ".env");
  const examplePath = path.join(REPO_ROOT, ".env.example");
  if (fs.existsSync(envPath)) {
    logOk(".env exists");
    return;
  }
  if (fs.existsSync(examplePath)) {
    fs.copyFileSync(examplePath, envPath);
    logWarn(".env missing — copied from .env.example. Edit APP_SECRET, PROXY_API_KEY, DATABASE_URL then re-run `bun run setup`.");
    return;
  }
  logFail(".env and .env.example missing — cannot bootstrap.");
  throw new Error("missing env");
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    usage();
    return 0;
  }
  const checkOnly = args.includes("--check");

  printHeader(`Oh My Omop - Router setup — ${currentPlatformLabel()} — ${process.platform} ${process.arch}`);
  logInfo(`Repo: ${REPO_ROOT}`);
  logInfo(`Bun ${Bun.version} — Node ${process.version}`);

  // 1) .env
  printHeader("1/4 — .env");
  try {
    await ensureEnv();
  } catch {
    return 1;
  }

  if (checkOnly) {
    logOk("setup --check: env ok, skipping infra/migrate/doctor");
    return 0;
  }

  // 2) infra:up
  printHeader("2/4 — infra:up");
  let infra = await spawnWithTimeout(["bun", "run", "infra:up"], { cwd: REPO_ROOT, timeoutMs: 180_000 });
  if (infra.stdout.trim()) console.log(infra.stdout.trim());
  if (infra.stderr.trim()) console.error(infra.stderr.trim());
  if (infra.timedOut) {
    logFail("infra:up timed out");
    return 4;
  }
  if (infra.exitCode !== 0) {
    logWarn(`infra:up exited ${infra.exitCode} — continuing to migrate (local fallback may still work)`);
  } else {
    logOk("infra:up succeeded");
  }

  // 3) db:migrate
  printHeader("3/4 — db:migrate");
  const migrate = await spawnWithTimeout(["bun", "run", "db:migrate"], { cwd: REPO_ROOT, timeoutMs: 90_000 });
  if (migrate.stdout.trim()) console.log(migrate.stdout.trim());
  if (migrate.stderr.trim()) console.error(migrate.stderr.trim());
  if (migrate.timedOut) {
    logFail("db:migrate timed out");
    return 3;
  }
  if (migrate.exitCode !== 0) {
    logFail(`db:migrate failed (exit ${migrate.exitCode}) — check DATABASE_URL and postgresql status`);
    return 3;
  }
  logOk("db:migrate succeeded");

  // 4) doctor
  printHeader("4/4 — doctor");
  const doctor = await spawnWithTimeout(["bun", "run", "doctor"], { cwd: REPO_ROOT, timeoutMs: 30_000 });
  if (doctor.stdout.trim()) console.log(doctor.stdout.trim());
  if (doctor.stderr.trim()) console.error(doctor.stderr.trim());
  if (doctor.timedOut) logWarn("doctor timed out");
  else if (doctor.exitCode !== 0) logWarn(`doctor exited ${doctor.exitCode} (check warnings above)`);

  console.log("\n✓ Setup complete. Next: bun run dev:all  (backend + dashboard)");
  console.log(`  Platform: ${currentPlatformLabel()} — Docker auto when available, else local PostgreSQL`);
  return 0;
}

const code = await main();
process.exit(code);
