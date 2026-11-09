#!/usr/bin/env bun
/**
 * infra — Oh My Omop - Router infrastructure orchestration (cross-OS)
 *
 * Commands: up | down | status
 * - Detects `docker compose` then `docker-compose` (Bun.spawn arrays, timeout)
 * - When Docker available: runs health-checked postgres (and redis via --profile redis)
 * - When Docker unavailable: validates Laragon/local DATABASE_URL + optional REDIS_URL,
 *   tests SELECT 1 / PING, then invokes the SAME migration command:
 *     bun run scripts/dev/migrate.ts  (which delegates to src/persistence/migrate.ts)
 *
 * Cross-OS: node:path, Bun.spawn argument arrays, timeouts/abort, windowsHide,
 * secret redaction, no Bash/grep/sed.
 */
import path from "node:path";
import {
  REPO_ROOT,
  redact,
  redactUrl,
  validateDatabaseUrl,
  validateRedisUrl,
  detectDockerCompose,
  checkPostgres,
  checkRedis,
  migrationEntryExists,
  spawnWithTimeout,
  composeFileExists,
  printHeader,
  logOk,
  logWarn,
  logFail,
  logInfo,
  isWindows,
  isMacOS,
  isLinux,
  localPostgresHints,
  tryAutoStartLocalPostgres,
} from "./dev/_shared.ts";

const DOCKER_UP_TIMEOUT_MS = 120_000;
const DOCKER_DOWN_TIMEOUT_MS = 60_000;
const DOCKER_STATUS_TIMEOUT_MS = 15_000;
const MIGRATE_TIMEOUT_MS = 60_000;

function usage(): void {
  console.log(`Usage: bun run ops/infra.ts <command> [options]

Commands:
  up       Start infrastructure (Docker if available, else validate local services) and run migrations
  down     Stop infrastructure (Docker) or no-op for local mode
  status   Show infrastructure status (Docker ps or local connectivity)
  --help   Show this help

Options:
  --with-redis   When Docker is available, start redis profile as well (docker compose --profile redis up -d)

Env:
  DATABASE_URL  Required for local path; also used by Docker migration (host-mapped postgres)
  REDIS_URL     Optional — when set, PING is tested; Docker redis profile uses it when --with-redis

Cross-OS:
  Docker auto when available. Local fallback is OS-aware:
    Windows → Laragon (PostgreSQL Start All) or Windows service
    macOS   → brew services start postgresql@16
    Linux   → systemctl / service

Examples:
  bun run infra:up              # Docker or Laragon local fallback
  bun run infra:up -- --with-redis
  bun run infra:status
  bun run infra:down
`);
}

type InfraCommand = "up" | "down" | "status";

function parseCommand(): { command: InfraCommand | null; withRedis: boolean; help: boolean } {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h") || args.length === 0) {
    // If no command but help flag, return help; if truly no args, caller will show usage
    if (args.includes("--help") || args.includes("-h")) return { command: null, withRedis: false, help: true };
    return { command: null, withRedis: args.includes("--with-redis"), help: true };
  }
  const raw = String(args[0] ?? "").toLowerCase();
  let command: InfraCommand | null = null;
  if (raw === "up" || raw === "down" || raw === "status") command = raw as InfraCommand;
  return { command, withRedis: args.includes("--with-redis"), help: false };
}

async function runDockerUp(composeArgs: string[], withRedis: boolean): Promise<number> {
  const hasCompose = composeFileExists();
  if (!hasCompose) {
    logWarn("No compose file found (docker-compose.yml) — trying `docker compose up` anyway (may fail)");
  }

  const profileArgs: string[] = withRedis ? ["--profile", "redis"] : [];
  // Preferred: `up -d --wait` waits for healthchecks (postgres healthy)
  const upArgs = [...composeArgs, ...profileArgs, "up", "-d", "--wait"];
  logInfo(`Docker: ${[...composeArgs, ...profileArgs, "up", "-d", "--wait"].join(" ")} (timeout ${DOCKER_UP_TIMEOUT_MS}ms)`);
  let result = await spawnWithTimeout(upArgs, { cwd: REPO_ROOT, timeoutMs: DOCKER_UP_TIMEOUT_MS });

  if (result.timedOut) {
    logFail(`docker compose up timed out after ${DOCKER_UP_TIMEOUT_MS}ms`);
    if (result.stderr) console.error(result.stderr);
    return 4;
  }
  // If --wait not supported (older compose), retry without --wait
  if (result.exitCode !== 0 && /unknown flag.*wait|unknown.*--wait/i.test(`${result.stderr} ${result.stdout}`)) {
    logWarn("Compose does not support --wait; retrying without it (healthchecks still configured)");
    const retryArgs = [...composeArgs, ...profileArgs, "up", "-d"];
    logInfo(`Docker: ${retryArgs.join(" ")}`);
    result = await spawnWithTimeout(retryArgs, { cwd: REPO_ROOT, timeoutMs: DOCKER_UP_TIMEOUT_MS });
    if (result.timedOut) {
      logFail("docker compose up (retry) timed out");
      return 4;
    }
  }

  if (result.stdout.trim()) console.log(result.stdout.trim());
  if (result.stderr.trim()) console.error(result.stderr.trim());

  if (result.exitCode !== 0) {
    logFail(`docker compose up failed (exit ${result.exitCode})`);
    logInfo("Hint: ensure Docker Desktop is running, ports 5432/6379/12800 are free, and .env has APP_SECRET/PROXY_API_KEY");
    return 4;
  }
  logOk("Docker: compose up succeeded");

  // Run migrations via same command as local branch
  logInfo(`Migrations: bun run scripts/dev/migrate.ts (timeout ${MIGRATE_TIMEOUT_MS}ms)…`);
  const migrateResult = await spawnWithTimeout(["bun", "run", path.join(REPO_ROOT, "scripts", "dev", "migrate.ts")], {
    cwd: REPO_ROOT,
    timeoutMs: MIGRATE_TIMEOUT_MS,
  });
  if (migrateResult.stdout.trim()) console.log(migrateResult.stdout.trim());
  if (migrateResult.stderr.trim()) console.error(migrateResult.stderr.trim());
  if (migrateResult.timedOut) {
    logFail(`Migrations timed out after ${MIGRATE_TIMEOUT_MS}ms`);
    return 3;
  }
  if (migrateResult.exitCode !== 0) {
    logFail(`Migrations failed (exit ${migrateResult.exitCode})`);
    return migrateResult.exitCode;
  }
  logOk("Migrations: up-to-date");
  console.log("\nInfra up complete (Docker + migrations).");
  return 0;
}

async function runDockerDown(composeArgs: string[]): Promise<number> {
  const downArgs = [...composeArgs, "down"];
  logInfo(`Docker: ${downArgs.join(" ")} (timeout ${DOCKER_DOWN_TIMEOUT_MS}ms)`);
  const result = await spawnWithTimeout(downArgs, { cwd: REPO_ROOT, timeoutMs: DOCKER_DOWN_TIMEOUT_MS });
  if (result.stdout.trim()) console.log(result.stdout.trim());
  if (result.stderr.trim()) console.error(result.stderr.trim());
  if (result.timedOut) {
    logFail("docker compose down timed out");
    return 4;
  }
  if (result.exitCode !== 0) {
    logFail(`docker compose down failed (exit ${result.exitCode})`);
    return 4;
  }
  logOk("Docker: compose down succeeded");
  return 0;
}

async function runDockerStatus(composeArgs: string[]): Promise<number> {
  // Show ps and short logs; use argument arrays, Windows-safe
  const psArgs = [...composeArgs, "ps", "-a"];
  logInfo(`Docker: ${psArgs.join(" ")}`);
  const ps = await spawnWithTimeout(psArgs, { cwd: REPO_ROOT, timeoutMs: DOCKER_STATUS_TIMEOUT_MS });
  if (ps.stdout.trim()) console.log(ps.stdout.trim());
  if (ps.stderr.trim()) console.error(ps.stderr.trim());
  if (ps.timedOut) logWarn("docker compose ps timed out");
  else if (ps.exitCode !== 0) logWarn(`docker compose ps exited ${ps.exitCode}`);

  // Also show compose config sanity (optional, not shell-parsed)
  const configArgs = [...composeArgs, "config", "--quiet"];
  const cfg = await spawnWithTimeout(configArgs, { cwd: REPO_ROOT, timeoutMs: 8_000 });
  if (cfg.exitCode === 0) logOk("Compose config: valid");
  else if (!cfg.timedOut) logWarn(`Compose config check: exit ${cfg.exitCode}${cfg.stderr.trim() ? ` — ${cfg.stderr.trim().slice(0, 200)}` : ""}`);

  if (migrationEntryExists()) {
    logInfo("Migration status: bun run scripts/dev/migrate.ts --status");
    const m = await spawnWithTimeout(["bun", "run", path.join(REPO_ROOT, "scripts", "dev", "migrate.ts"), "--status"], {
      cwd: REPO_ROOT,
      timeoutMs: 15_000,
    });
    if (m.stdout.trim()) console.log(m.stdout.trim());
    if (m.stderr.trim()) console.error(m.stderr.trim());
    if (m.exitCode === 0) logOk("Migration status: checked");
    else logWarn(`Migration status: exit ${m.exitCode}`);
  } else {
    logInfo("Migration status: runner not yet present (wave in progress)");
  }

  return 0;
}

// ── Local (cross-OS) branches ──────────────────────────────────────────────

async function runLocalUp(): Promise<number> {
  const databaseUrl = process.env["DATABASE_URL"];
  const redisUrl = process.env["REDIS_URL"];

  const platform = isWindows ? "Windows (Laragon)" : isMacOS ? "macOS (Homebrew)" : "Linux (systemd)";
  printHeader(`Local mode — ${platform} (Docker unavailable)`);

  const dbValidation = validateDatabaseUrl(databaseUrl);
  if (!dbValidation.valid) {
    logFail(dbValidation.reason ?? "DATABASE_URL invalid");
    console.log("\nActionable (local):");
    for (const hint of localPostgresHints(databaseUrl)) console.log(`  • ${hint}`);
    return 1;
  }
  logOk(`DATABASE_URL: ${redact(databaseUrl)}`);

  const redisValidation = validateRedisUrl(redisUrl);
  if (!redisValidation.valid) {
    logFail(redisValidation.reason ?? "REDIS_URL invalid");
    return 1;
  }
  if (redisUrl) logOk(`REDIS_URL: ${redact(redisUrl)}`);
  else logInfo("REDIS_URL: (not set) — local coordination");

  logInfo(`PostgreSQL: SELECT 1 against ${redactUrl(databaseUrl!)} (timeout 8000ms)…`);
  let pg = await checkPostgres(databaseUrl!, 8_000);
  if (!pg.ok) {
    logWarn(`PostgreSQL not reachable — ${pg.error}`);
    logInfo("Attempting OS-aware auto-start (best-effort)...");
    const attempt = await tryAutoStartLocalPostgres();
    if (attempt.attempted) {
      logInfo(`Auto-start: ${attempt.label} ${attempt.ok ? "— ok, re-checking..." : `— ${attempt.error ?? "failed"}`}`);
      // Give postgres a moment to start
      await new Promise((r) => setTimeout(r, 2_000));
      pg = await checkPostgres(databaseUrl!, 8_000);
    } else {
      logInfo(`Auto-start not attempted: ${attempt.label} (manual step required)`);
    }
  if (!pg.ok) {
    logFail(`PostgreSQL: SELECT 1 failed — ${pg.error}`);
    console.log("\nActionable:");
      for (const hint of localPostgresHints(databaseUrl)) console.log(`  • ${hint}`);
    return 2;
    }
  }
  logOk("PostgreSQL: SELECT 1 succeeded");

  if (redisUrl) {
    logInfo(`Redis: PING against ${redactUrl(redisUrl)} (timeout 5000ms)…`);
    const r = await checkRedis(redisUrl, 5_000);
    if (!r.ok) {
      logWarn(`Redis: PING failed — ${r.error} (optional; continuing)`);
      logInfo("Hint: start redis-server or unset REDIS_URL to use local coordination");
    } else {
      logOk("Redis: PING succeeded");
    }
  }

  // Same migration command as Docker branch
  logInfo(`Migrations: bun run scripts/dev/migrate.ts (timeout ${MIGRATE_TIMEOUT_MS}ms)…`);
  const migrateResult = await spawnWithTimeout(["bun", "run", path.join(REPO_ROOT, "scripts", "dev", "migrate.ts")], {
    cwd: REPO_ROOT,
    timeoutMs: MIGRATE_TIMEOUT_MS,
  });
  if (migrateResult.stdout.trim()) console.log(migrateResult.stdout.trim());
  if (migrateResult.stderr.trim()) console.error(migrateResult.stderr.trim());
  if (migrateResult.timedOut) {
    logFail(`Migrations timed out after ${MIGRATE_TIMEOUT_MS}ms`);
    return 3;
  }
  if (migrateResult.exitCode !== 0) {
    logFail(`Migrations failed (exit ${migrateResult.exitCode})`);
    return migrateResult.exitCode;
  }
  logOk("Migrations: up-to-date");
  console.log(`\nInfra up complete (local ${platform} PostgreSQL + migrations).`);
  return 0;
}

async function runLocalDown(): Promise<number> {
  const platform = isWindows ? "Windows (Laragon)" : isMacOS ? "macOS" : "Linux";
  printHeader(`Local mode — ${platform} infra:down`);
  logInfo("Local PostgreSQL/Redis are not managed by Compose; nothing to stop.");
  logInfo("To stop local services (OS-aware):");
  if (isWindows) {
  logInfo("  • Laragon: Stop All or Services → PostgreSQL → Stop");
  logInfo("  • Windows service:  net stop postgresql-x64-16");
  } else if (isMacOS) {
    logInfo("  • brew services stop postgresql@16  (or @15)");
  } else {
    logInfo("  • sudo systemctl stop postgresql  (or  sudo service postgresql stop)");
  }
  logInfo("  • Redis (if running):  redis-cli shutdown  or stop service");
  // Still check connectivity as status hint
  const databaseUrl = process.env["DATABASE_URL"];
  if (databaseUrl && validateDatabaseUrl(databaseUrl).valid) {
    const pg = await checkPostgres(databaseUrl, 3_000);
    logInfo(`PostgreSQL ${redactUrl(databaseUrl)}: ${pg.ok ? "reachable" : `unreachable — ${pg.error}`}`);
  }
  return 0;
}

async function runLocalStatus(): Promise<number> {
  const platform = isWindows ? "Windows (Laragon)" : isMacOS ? "macOS (Homebrew)" : "Linux (systemd)";
  printHeader(`Local status — ${platform} (Docker unavailable)`);
  const databaseUrl = process.env["DATABASE_URL"];
  const redisUrl = process.env["REDIS_URL"];

  if (!databaseUrl || !validateDatabaseUrl(databaseUrl).valid) {
    logFail("DATABASE_URL: missing or invalid — cannot check connectivity");
    console.log(`  Current: ${redact(databaseUrl)}`);
  } else {
    logInfo(`DATABASE_URL: ${redact(databaseUrl)}`);
    logInfo(`PostgreSQL: SELECT 1 (timeout 5000ms)…`);
    const pg = await checkPostgres(databaseUrl, 5_000);
    if (pg.ok) logOk("PostgreSQL: reachable (SELECT 1)");
    else logFail(`PostgreSQL: unreachable — ${pg.error}`);
  }

  if (redisUrl) {
    if (!validateRedisUrl(redisUrl).valid) logFail(`REDIS_URL invalid: ${redact(redisUrl)}`);
    else {
      logInfo(`REDIS_URL: ${redact(redisUrl)}`);
      const r = await checkRedis(redisUrl, 5_000);
      if (r.ok) logOk("Redis: reachable (PING)");

    }
  } else {
    logInfo("REDIS_URL: (not set) — coordination=local");
  }

  if (migrationEntryExists()) {
    logInfo("Migration status: bun run scripts/dev/migrate.ts --status");
    const m = await spawnWithTimeout(["bun", "run", path.join(REPO_ROOT, "scripts", "dev", "migrate.ts"), "--status"], {
      cwd: REPO_ROOT,
      timeoutMs: 15_000,
    });
    if (m.stdout.trim()) console.log(m.stdout.trim());
    if (m.stderr.trim()) console.error(m.stderr.trim());
    if (m.exitCode === 0) logOk("Migrations: status checked");
    else logWarn(`Migrations: status exit ${m.exitCode}`);
  } else {
    logWarn("Migrations: runner not present yet");
  }

  logInfo("Docker: not available (checked docker compose, docker-compose)");
  return 0;
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const { command, withRedis, help } = parseCommand();
  if (help || !command) {
    usage();
    // Exit 0 for --help, 1 for missing command
    return help && process.argv.slice(2).length > 0 ? 0 : 1;
  }

  console.log(`\x1b[1mOh My Omop - Router infra:${command}\x1b[0m — ${withRedis ? "with redis" : "standard"}`);
  console.log(`Repo: ${REPO_ROOT}`);

  const docker = await detectDockerCompose(8_000);

  if (docker) {
    logOk(`Detected: ${docker.label} (${docker.args.join(" ")}) — using Docker path`);
    if (command === "up") return await runDockerUp(docker.args, withRedis);
    if (command === "down") return await runDockerDown(docker.args);
    return await runDockerStatus(docker.args);
  }

  logWarn("Docker not available (tried docker compose, docker-compose) — using local/Laragon path");
  if (command === "up") return await runLocalUp();
  if (command === "down") return await runLocalDown();
  return await runLocalStatus();
}

const code = await main();
process.exit(code);
