#!/usr/bin/env bun
/**
 * migrate — Run PostgreSQL migrations (cross-OS)
 *
 * Validates DATABASE_URL (Postgres) + optional REDIS_URL, tests connectivity
 * (SELECT 1 / PING), then invokes the Drizzle PG runtime migration:
 *   bun run src/persistence/migrate.ts  (reads drizzle/pg via readMigrationFiles)
 *
 * Called directly via `bun run db:migrate` and indirectly via `bun run infra:up`
 * in both Docker and local (Laragon) branches.
 *
 * Cross-OS: Bun.spawn argument arrays, node:path, timeouts, redacted logs.
 */
import path from "node:path";
import {
  REPO_ROOT,
  redact,
  redactUrl,
  validateDatabaseUrl,
  validateRedisUrl,
  checkPostgres,
  checkRedis,
  migrationEntryExists,
  spawnWithTimeout,
  printHeader,
  logOk,
  logWarn,
  logFail,
  logInfo,
} from "./_shared.ts";

const MIGRATION_TIMEOUT_MS = 60_000;
const CONNECT_TIMEOUT_MS = 8_000;

function usage(): void {
  console.log(`Usage: bun run scripts/migrate.ts [options]

Options:
  --status    Show migration status without applying (exit 0 if up-to-date)
  --help, -h  Show this help

Env:
  DATABASE_URL  Required — PostgreSQL URL (postgres:// or postgresql://)
  REDIS_URL     Optional — Redis URL (redis:// or rediss://); PING is tested when set

Behavior:
  Validates URLs (redacted in logs), tests PostgreSQL SELECT 1 and optional Redis PING,
  then runs the same migration command: bun run src/persistence/migrate.ts
  Uses Bun.spawn argument arrays, timeouts, Windows-safe spawn, no shell syntax.
`);
}

async function runPersistenceMigrate(extraArgs: string[]): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }> {
  const entry = path.join(REPO_ROOT, "src", "persistence", "migrate.ts");
  const args: string[] = ["bun", "run", entry, ...extraArgs];
  logInfo(`Running: bun run src/persistence/migrate.ts ${extraArgs.join(" ")} (timeout ${MIGRATION_TIMEOUT_MS}ms)`);
  const result = await spawnWithTimeout(args, {
    cwd: REPO_ROOT,
    timeoutMs: MIGRATION_TIMEOUT_MS,
  });
  return result;
}

async function main(): Promise<number> {
  const rawArgs = process.argv.slice(2);
  if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
    usage();
    return 0;
  }
  const isStatus = rawArgs.includes("--status");

  console.log("\x1b[1mOh My Omop - Router migrate\x1b[0m — PostgreSQL migrations");
  console.log(`Repo: ${REPO_ROOT}`);

  const databaseUrl = process.env["DATABASE_URL"];
  const redisUrl = process.env["REDIS_URL"];

  // ── Validate URLs ─────────────────────────────────────────────────────────
  const dbValidation = validateDatabaseUrl(databaseUrl);
  if (!dbValidation.valid) {
    logFail(dbValidation.reason ?? "DATABASE_URL invalid");
    console.log("\nActionable: set DATABASE_URL to a PostgreSQL URL");
    console.log("  Example: postgresql://ohmyomop_router:***@127.0.0.1:5432/ohmyomop_router");
    console.log("  Docker:   postgresql://ohmyomop_router:ohmyomop_router@127.0.0.1:5432/ohmyomop_router  (host-mapped)");
    console.log("  Laragon:  postgresql://postgres:***@127.0.0.1:5432/ohmyomop_router");
    return 1;
  }
  logOk(`DATABASE_URL: ${redact(databaseUrl)}`);

  const redisValidation = validateRedisUrl(redisUrl);
  if (!redisValidation.valid) {
    logFail(redisValidation.reason ?? "REDIS_URL invalid");
    console.log("\nActionable: fix REDIS_URL to redis://host:port or unset it");
    return 1;
  }
  if (redisUrl) logOk(`REDIS_URL: ${redact(redisUrl)}`);
  else logInfo("REDIS_URL: (not set) — migrations do not require Redis");

  if (!migrationEntryExists()) {
    logFail("Migration runner missing at src/persistence/migrate.ts");
    return 1;
  }

  // ── Connectivity ──────────────────────────────────────────────────────────
  printHeader("Connectivity");
  logInfo(`PostgreSQL: SELECT 1 against ${redactUrl(databaseUrl!)} (timeout ${CONNECT_TIMEOUT_MS}ms)…`);
  const pg = await checkPostgres(databaseUrl!, CONNECT_TIMEOUT_MS);
  if (!pg.ok) {
    logFail(`PostgreSQL: SELECT 1 failed — ${pg.error}`);
    logInfo("Hint: ensure PostgreSQL is running and DATABASE_URL is reachable");
    logInfo("  Docker: bun run infra:up  (starts health-checked postgres)");
    logInfo("  Laragon: start PostgreSQL service and check firewall");
    return 2;
  }
  logOk("PostgreSQL: SELECT 1 succeeded");

  if (redisUrl) {
    logInfo(`Redis: PING against ${redactUrl(redisUrl)} (timeout 5000ms)…`);
    const r = await checkRedis(redisUrl, 5_000);
    if (!r.ok) {
      logWarn(`Redis: PING failed — ${r.error} (optional; continuing)`);
      // Migrations do not require Redis, so do not fail
    } else {
      logOk("Redis: PING succeeded");
    }
  }

  // ── Run migrations ────────────────────────────────────────────────────────
  printHeader(isStatus ? "Migration status" : "Migrations");
  const extraArgs = isStatus ? ["--status"] : [];
  const result = await runPersistenceMigrate(extraArgs);

  if (result.stdout.trim()) console.log(result.stdout.trim());
  if (result.stderr.trim()) console.error(result.stderr.trim());

  if (result.timedOut) {
    logFail(`Migration ${isStatus ? "status" : "run"} timed out after ${MIGRATION_TIMEOUT_MS}ms`);
    return 3;
  }
  if (result.exitCode !== 0) {
    logFail(`Migration ${isStatus ? "status" : "run"} failed (exit ${result.exitCode})`);
    logInfo("Hint: check migration logs above; ensure DATABASE_URL has DDL privileges");
    return 3;
  }

  logOk(isStatus ? "Migration status: up-to-date or reported above" : "Migrations applied (or already current)");
  return 0;
}

const code = await main();
process.exit(code);
