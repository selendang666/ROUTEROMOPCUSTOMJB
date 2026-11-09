#!/usr/bin/env bun
/**
 * doctor — Oh My Omop - Router environment diagnostics (cross-OS)
 *
 * Checks: Bun/Node/platform, Docker variant, DATABASE_URL/REDIS_URL validity,
 * PostgreSQL SELECT 1, Redis PING, Drizzle PG artifacts in drizzle/pg.
 *
 * Cross-OS: Bun.spawn argument arrays, node:path, timeouts, Windows-safe spawn,
 * secret redaction, no Bash/grep/sed.
 */
import path from "node:path";
import fs from "node:fs";
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
  migrationsDirExists,
  composeFileExists,
  printHeader,
  logOk,
  logWarn,
  logFail,
  logInfo,
  isWindows,
  isMacOS,
  isLinux,
  getResourceSnapshot,
  formatGb,
  isPortFree,
  checkPostgresDeep,
  localPostgresHints,
} from "./_shared.ts";

async function main(): Promise<number> {
  let exitCode = 0;
  const failures: string[] = [];
  const warnings: string[] = [];

  console.log("\x1b[1mOh My Omop - Router doctor\x1b[0m — environment diagnostics (early-warning)");
  console.log(`Repo: ${REPO_ROOT}`);
  console.log(`Time: ${new Date().toISOString()}`);

  // ── Platform + Resource early-warning ───────────────────────────────────
  printHeader("Platform & resources (early-warning)");
  logInfo(`platform: ${process.platform}  arch: ${process.arch}  cpus: ${require("node:os").cpus().length}`);
  logInfo(`bun: ${Bun.version}  node: ${process.version}`);
  logInfo(`cwd: ${process.cwd()}`);
  logInfo(`argv: ${process.argv.slice(0, 2).join(" ")}`);
  const bunMajor = Number.parseInt(Bun.version.split(".")[0] ?? "0", 10);
  if (Number.isNaN(bunMajor) || bunMajor < 1) {
    logWarn(`Bun version looks unexpected: ${Bun.version} (expected >=1.4)`);
    warnings.push("bun version");
  } else if (bunMajor === 1) {
    const minor = Number.parseInt(Bun.version.split(".")[1] ?? "0", 10);
    if (minor < 4) {
      logWarn(`Bun ${Bun.version} < 1.4 — upgrade recommended for SQL/Redis native APIs`);
      warnings.push("bun <1.4");
    } else {
      logOk(`Bun ${Bun.version}`);
    }
  } else {
    logOk(`Bun ${Bun.version}`);
  }
  const res = getResourceSnapshot();
  logInfo(`memory: free ${formatGb(res.freeMemGb)} / total ${formatGb(res.totalMemGb)}  cpus: ${res.cpus}  loadavg: ${res.loadAvg.map((n) => n.toFixed(2)).join(" ")}`);
  if (res.freeMemGb >= 0 && res.freeMemGb < 0.5) {
    logWarn(`Low free memory ${formatGb(res.freeMemGb)} — expect OOM under load (app + dashboard + postgres)`);
    warnings.push("low memory");
  } else if (res.freeMemGb >= 0) logOk(`memory free ${formatGb(res.freeMemGb)}`);
  logInfo(`disk (repo): free ${formatGb(res.freeGb)} / total ${formatGb(res.totalGb)}`);
  if (res.freeGb >= 0 && res.freeGb < 1) {
    logFail(`Disk free <1 GB ${formatGb(res.freeGb)} — telemetry flush + build will fail`);
    failures.push("disk <1GB");
    exitCode = 1;
  } else if (res.freeGb >= 0 && res.freeGb < 5) {
    logWarn(`Disk free <5 GB ${formatGb(res.freeGb)} — clean up soon`);
    warnings.push("disk <5GB");
  } else if (res.freeGb >= 0) logOk(`disk free ${formatGb(res.freeGb)}`);
  if (res.totalGb < 0) logInfo("disk: unknown (statfs not available — skipping threshold)");

  // ── Files ─────────────────────────────────────────────────────────────────
  printHeader("Files");
  const hasCompose = composeFileExists();
  logInfo(`compose file: ${hasCompose ? "found" : "not found (local-only mode)"}`);
  if (!hasCompose) logWarn("docker-compose.yml / compose.yml not found — will use local DATABASE_URL path");
  const envPath = path.join(REPO_ROOT, ".env");
  const envExists = fs.existsSync(envPath);
  logInfo(`.env: ${envExists ? "present" : "missing (.env.example will be used by setup)"}`);
  if (!envExists) warnings.push(".env missing");
  const nodeModulesExists = fs.existsSync(path.join(REPO_ROOT, "node_modules"));
  logInfo(`node_modules: ${nodeModulesExists ? "present" : "missing — run bun install"}`);
  if (!nodeModulesExists) warnings.push("node_modules missing");
  else {
    const lockbPath = path.join(REPO_ROOT, "bun.lockb");
    const lockPath = path.join(REPO_ROOT, "bun.lock");
    const lockFile = fs.existsSync(lockbPath) ? lockbPath : fs.existsSync(lockPath) ? lockPath : null;
    if (!lockFile) {
      logWarn("bun.lock / bun.lockb missing — lockfile drift risk");
      warnings.push("bun.lock missing");
    } else {
      try {
        const lockStat = fs.statSync(lockFile);
        const pkgStat = fs.statSync(path.join(REPO_ROOT, "package.json"));
        if (lockStat.mtimeMs < pkgStat.mtimeMs) {
          logWarn(`${path.basename(lockFile)} older than package.json — run bun install`);
          warnings.push(`${path.basename(lockFile)} stale`);
        } else logOk(`${path.basename(lockFile)} fresh`);
      } catch {}
    }
  }
  const telemetryPath = process.env["SQLITE_PATH"] ?? path.join(REPO_ROOT, "data", "telemetry.db");
  try {
    fs.mkdirSync(path.dirname(path.resolve(REPO_ROOT, telemetryPath)), { recursive: true });
    const probe = path.join(path.dirname(path.resolve(REPO_ROOT, telemetryPath)), ".doctor-write-test");
    fs.writeFileSync(probe, "ok");
    fs.unlinkSync(probe);
    logOk(`telemetry path writable: ${telemetryPath}`);
  } catch (e) {
    logWarn(`telemetry path not writable: ${telemetryPath} — ${(e as Error).message}`);
    warnings.push("telemetry path not writable");
  }
  const dataDir = path.join(REPO_ROOT, "data");
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const probe2 = path.join(dataDir, ".doctor-write-test");
    fs.writeFileSync(probe2, "ok");
    fs.unlinkSync(probe2);
    logOk("data dir writable");
  } catch (e) {
    logWarn(`data dir not writable: ${(e as Error).message}`);
    warnings.push("data dir not writable");
  }

  const hasMigrateEntry = migrationEntryExists();
  const hasMigrationsDir = migrationsDirExists();
  logInfo(`migration entry: ${hasMigrateEntry ? "src/persistence/migrate.ts present" : "not yet present"}`);
  if (hasMigrationsDir) {
    const dir = path.join(REPO_ROOT, "drizzle", "pg");
    const files = fs.readdirSync(dir).filter((file) => file.endsWith(".sql")).sort();
    logInfo(`Drizzle PG migrations: ${files.length} .sql file(s) — ${files.slice(0, 5).join(", ")}${files.length > 5 ? " …" : ""}`);
    if (files.length === 0) logWarn("Drizzle PG migrations empty");
    else logOk(`Drizzle PG migrations: ${files.length} file(s)`);
    try {
      const journal = JSON.parse(fs.readFileSync(path.join(dir, "meta", "_journal.json"), "utf8")) as { entries?: unknown[] };
      const jLen = Array.isArray(journal.entries) ? journal.entries.length : -1;
      if (jLen !== files.length) {
        logWarn(`journal entries ${jLen} != sql files ${files.length} — drizzle-kit generate drift?`);
        warnings.push("journal/sql drift");
      } else logOk(`journal entries ${jLen} matches sql files`);
    } catch (e) {
      logWarn(`journal unreadable — ${(e as Error).message}`);
      warnings.push("journal unreadable");
    }
  } else {
    logWarn("drizzle/pg/meta/_journal.json not found");
    warnings.push("Drizzle PG migration artifacts missing");
  }
  if (hasMigrateEntry) logOk("migration entry exists");
  else warnings.push("migration entry missing");

  // ── Docker ────────────────────────────────────────────────────────────────
  printHeader("Docker");
  const docker = await detectDockerCompose(8_000);
  if (docker) {
    logOk(`detected: ${docker.label} (${docker.args.join(" ")})`);
    logInfo("infra:up will use Docker path (health-checked Postgres + optional Redis)");
  } else {
    logInfo("Docker not available (tried: docker compose, docker-compose) — using local path");
    logInfo("Local: Laragon/Postgres native (Win) / brew (macOS) / systemd (Linux) will be used by infra:up");
  }

  // ── Environment variables ─────────────────────────────────────────────────
  printHeader("Environment");
  const databaseUrl = process.env["DATABASE_URL"];
  const redisUrl = process.env["REDIS_URL"];

  const dbValidation = validateDatabaseUrl(databaseUrl);
  if (dbValidation.valid) {
    logOk(`DATABASE_URL: ${redact(databaseUrl)} (postgres scheme)`);
  } else {
    logFail(dbValidation.reason ?? "DATABASE_URL invalid");
    failures.push("DATABASE_URL");
    exitCode = 1;
  }

  const redisValidation = validateRedisUrl(redisUrl);
  if (redisValidation.valid) {
    if (redisUrl) logOk(`REDIS_URL: ${redact(redisUrl)}`);
    else logInfo("REDIS_URL: (not set) — local coordination will be used");
  } else {
    logFail(redisValidation.reason ?? "REDIS_URL invalid");
    failures.push("REDIS_URL");
    exitCode = 1;
  }

  // Security-sensitive env — early warning before runtime fail-fast
  const appSecret = process.env["APP_SECRET"];
  if (!appSecret) {
    logFail("APP_SECRET missing — runtime will fail-fast (encrypt key source). Set >=32 chars in .env");
    failures.push("APP_SECRET missing");
    exitCode = 1;
  } else if (appSecret.length < 32) {
    logFail(`APP_SECRET too short (${appSecret.length} < 32) — runtime fail-fast`);
    failures.push("APP_SECRET <32");
    exitCode = 1;
  } else logOk(`APP_SECRET: ${appSecret.length} chars`);
  const proxyKey = process.env["PROXY_API_KEY"];
  if (!proxyKey) {
    if (process.env["NODE_ENV"] === "production") {
      logFail("PROXY_API_KEY missing in production — runtime fail-fast");
      failures.push("PROXY_API_KEY");
      exitCode = 1;
    } else logWarn("PROXY_API_KEY not set (required in production; dev may use local header auth)");
  } else logOk("PROXY_API_KEY: set");
  const portRaw = process.env["PORT"];
  const portNum = portRaw ? Number.parseInt(portRaw, 10) : 12800;
  if (portRaw && (Number.isNaN(portNum) || portNum < 1 || portNum > 65535)) {
    logFail(`PORT invalid: ${portRaw}`);
    failures.push("PORT invalid");
    exitCode = 1;
  } else logInfo(`PORT: ${portRaw ?? "12800 (default)"}  HOST: ${process.env["HOST"] ?? "0.0.0.0"}`);
  const publicOrigin = process.env["PUBLIC_ORIGIN"];
  if (publicOrigin) logInfo(`PUBLIC_ORIGIN: ${publicOrigin}`);
  else logInfo("PUBLIC_ORIGIN: (not set)");

  // ── Ports (early conflict detection) ──────────────────────────────────────
  printHeader("Ports (early-warning)");
  const portChecks: Array<{ port: number; label: string; shouldBeFree: boolean }> = [
    { port: 5432, label: "PostgreSQL 5432", shouldBeFree: false },
    { port: 6379, label: "Redis 6379", shouldBeFree: false },
    { port: portNum, label: `App PORT ${portNum}`, shouldBeFree: true },
    { port: 5173, label: "Vite dashboard 5173", shouldBeFree: true },
  ];
  for (const pc of portChecks) {
    const r = await isPortFree(pc.port);
    if (pc.shouldBeFree) {
      if (!r.free) {
        logWarn(`${pc.label} in use — dev server may hit EADDRINUSE`);
        warnings.push(`${pc.label} in use`);
      } else logOk(`${pc.label} free`);
    } else {
      if (!r.free) logOk(`${pc.label} listening`);
      else logInfo(`${pc.label} not listening (expected if using Docker or local not started)`);
    }
  }

  // ── Connectivity ──────────────────────────────────────────────────────────
  printHeader("Connectivity");

  if (dbValidation.valid && databaseUrl) {
    logInfo(`PostgreSQL: testing SELECT 1 against ${redactUrl(databaseUrl)} (timeout 8000ms)…`);
    const pg = await checkPostgres(databaseUrl, 8_000);
    if (pg.ok) {
      logOk("PostgreSQL: SELECT 1 succeeded");
      const deep = await checkPostgresDeep(databaseUrl);
      if (deep.ok) {
        logOk(`PostgreSQL deep: server_version ${deep.version ?? "?"}  max_connections ${deep.maxConnections ?? "?"}`);
        if (deep.version) {
          const major = Number.parseInt(deep.version.split(".")[0] ?? "0", 10);
          if (!Number.isNaN(major) && major < 14) {
            logWarn(`PostgreSQL ${deep.version} <14 — some migrations (e.g. jsonb, advisory lock) expect >=14`);
            warnings.push("postgres <14");
          }
        }
        const mc = deep.maxConnections ? Number.parseInt(deep.maxConnections, 10) : NaN;
        if (!Number.isNaN(mc) && mc < 20) {
          logWarn(`max_connections ${mc} low — may exhaust under dev:all + tests`);
          warnings.push("max_connections low");
        }
      } else logWarn(`PostgreSQL deep check failed — ${deep.error}`);
    } else {
      logFail(`PostgreSQL: SELECT 1 failed — ${pg.error ?? "unknown error"}`);
      for (const hint of localPostgresHints(databaseUrl)) logInfo(`Hint: ${hint}`);
      failures.push("postgres SELECT 1");
      if (!docker) {
        logWarn("Both Docker and local PostgreSQL unavailable — no DB path left (Laragon/brew/systemd not reachable)");
        warnings.push("no DB path (docker + local)");
      }
      exitCode = 1;
    }
  } else {
    logWarn("PostgreSQL: skipped (DATABASE_URL invalid or missing)");
    if (!docker) {
      logWarn("DATABASE_URL invalid and Docker not available — fix .env first");
      warnings.push("no DB path (config + docker)");
    }
  }

  if (redisUrl && redisValidation.valid) {
    logInfo(`Redis: testing PING against ${redactUrl(redisUrl)} (timeout 5000ms)…`);
    const redis = await checkRedis(redisUrl, 5_000);
    if (redis.ok) {
      logOk("Redis: PING succeeded");
    } else {
      logWarn(`Redis: PING failed — ${redis.error ?? "unknown error"} (optional; local fallback will be used)`);
      logInfo("Hint: if Redis is optional, leave REDIS_URL unset; if required, ensure redis-server is running");
      warnings.push("redis PING");
      // Redis is optional: do not fail doctor hard
    }
  } else if (!redisUrl) {
    logInfo("Redis: skipped (REDIS_URL not set — local coordination)");
  }

  // ── Migrations ────────────────────────────────────────────────────────────
  printHeader("Migrations");
  if (dbValidation.valid && databaseUrl) {
    if (hasMigrateEntry) {
      logInfo("Migration status: invoking src/persistence/migrate.ts --status (timeout 15000ms)…");
      // Use Bun.spawn array, Windows-safe, redacted
      const { spawnWithTimeout } = await import("./_shared.ts");
      const result = await spawnWithTimeout(
        ["bun", "run", path.join(REPO_ROOT, "src", "persistence", "migrate.ts"), "--status"],
        { timeoutMs: 15_000, cwd: REPO_ROOT },
      );
      const combined = `${result.stdout}\n${result.stderr}`.trim();
      if (result.exitCode === 0) {
        logOk("Migrations: status check succeeded");
        if (combined) logInfo(combined.split("\n").slice(0, 20).join("\n"));
      } else if (result.timedOut) {
        logWarn(`Migrations: status timed out — ${result.stderr}`);
        warnings.push("migrations status timeout");
      } else {
        // If file not yet implemented, spawn will fail with module not found — treat as warning during wave
        if (/Cannot find module|ENOENT|not found/i.test(combined)) {
          logWarn("Migrations: runner not yet implemented (expected during wave 1) — skip");
          warnings.push("migrations runner not ready");
        } else {
          logWarn(`Migrations: status returned exit ${result.exitCode}`);
          if (combined) logInfo(combined.split("\n").slice(0, 40).join("\n"));
          warnings.push("migrations status non-zero");
        }
      }
    } else {
      logWarn("Migrations: runner not present — skip status check");
    }
  } else {
    logWarn("Migrations: skipped (requires valid DATABASE_URL)");
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  printHeader("Summary");
  if (failures.length === 0 && warnings.length === 0) {
    logOk("doctor: all checks passed (no early warnings)");
    console.log("");
    return 0;
  }
  if (failures.length > 0) {
    logFail(`doctor: ${failures.length} required check(s) failed — ${failures.join("; ")} (early-warning)`);
    if (warnings.length > 0) logWarn(`${warnings.length} warning(s) — ${warnings.join("; ")}`);
    console.log("\nActionable next steps (earliest first):");
    if (failures.some((f) => f.startsWith("APP_SECRET"))) console.log("  • Fix APP_SECRET (>=32 random chars):  bun -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"  then put in .env");
    if (failures.includes("DATABASE_URL")) console.log("  • Set DATABASE_URL e.g. postgresql://user:pass@127.0.0.1:5432/ohmyomop_router");
    if (failures.includes("postgres SELECT 1")) console.log("  • Run `bun run infra:up` (Docker) or start local PostgreSQL — hints above per OS");
    if (failures.some((f) => f.startsWith("disk"))) console.log("  • Free disk: remove node_modules/.tmp_build, Docker prune, data/*.db-wal");
    if (failures.includes("REDIS_URL")) console.log("  • Fix REDIS_URL to redis://host:port or unset it");
    if (failures.includes("PORT invalid")) console.log("  • Set PORT 1-65535 or unset for default 12800");
    console.log("");
    return exitCode || 1;
  }
  logWarn(`doctor: ${warnings.length} warning(s) — ${warnings.join("; ")} (early — fix before it becomes failure)`);
  console.log("  Required checks passed; warnings are early signals. Check Ports, Disk, Postgres version above.");
  console.log("  Run `bun run infra:up` if Postgres/Redis not listening, or free disk/memory.");
  console.log("");
  return 0;
}

const code = await main();
process.exit(code);
