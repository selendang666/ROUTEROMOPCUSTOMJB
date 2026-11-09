# Operations

> Merged: Environment + Persistence + Performance + Deployment — single ops manual.

```mermaid
graph TD
  Env --> Runtime --> Persistence --> Telemetry --> Retention
  Runtime --> ProxyPort --> Coordination
```

```text
ASCII: Env(.env) -> Runtime(limits) -> Pool/Migrate -> Coordination(Redis/local) -> Telemetry(SQLite/D1) -> Backup/Retention
```

## 1. Environment

`.env.example` is the source of truth. Active lines are required for the normal runtime; commented values are optional overrides.

## Mandatory (validated fail-fast in `src/runtime/runtime.ts`)

```dotenv
PORT=12800
DATABASE_URL=postgres://ohmyomop_router:ohmyomop_router@127.0.0.1:5432/ohmyomop_router
APP_SECRET=change-me-32-chars-min
PROXY_API_KEY=change-me-proxy-key
```

`PORT` is bounded 1-65535 fallback 12800 (`boundedPort` in `src/runtime/runtime.ts`); `DATABASE_URL` must be `postgres://`|`postgresql://` with hostname (`requireDatabaseUrl` in `src/runtime/runtime.ts` + `src/persistence/pool.ts`); `APP_SECRET` sole source `deriveCredentialEncryptionKey` SHA-256 (`src/runtime/runtime.ts` + `src/persistence/crypto.ts` `resolveEncryptionKey`), production requires ≥32 chars and non-placeholder — runtime pattern `(?:^|[^a-z0-9])(?:change-me|replace-with|password)` and persistence pattern `^(?:change-me|replace-with|replace_me|password|secret|default|example)(?:[-_].*)?$`; `APP_SECRET_PREV` is optional previous-key fallback for rotation (`src/persistence/crypto.ts` `decryptWithKey` tries `APP_SECRET_PREV` SHA-256 when primary fails); `PROXY_API_KEY` required in production (`assertProductionBootstrapSecrets` in `src/runtime/runtime.ts`). The first console account is created through the setup UI; there is no console-password environment variable. `PUBLIC_ORIGIN` (CORS/public URL), `SQLITE_PATH` (default `./data/telemetry.db` in `src/runtime/runtime.ts`), `DISABLE_LANDING_PAGE` (not read in `RuntimeConfig`), `HOST` (default `0.0.0.0`), `REDIS_URL` (optional), `TRUST_PROXY` (default `false`), `TELEMETRY_D1_*` (optional) are optional with defaults — code falls back, not crash.

## Optional backend and network settings

```dotenv
REDIS_URL=redis://127.0.0.1:6379/0
HOST=0.0.0.0
SQLITE_PATH=./data/telemetry.db
PUBLIC_ORIGIN=https://your.domain
DISABLE_LANDING_PAGE=false
TELEMETRY_D1_URL=https://...
TELEMETRY_D1_TOKEN=...
TRUST_PROXY=false
APP_SECRET_PREV=<previous-app-secret-for-rotation>
```

D1 is selected only when both D1 values are present (`src/persistence/telemetry/pipeline.ts` `if (d1Url && d1Token) D1TelemetryStore else SqliteTelemetryStore`). Otherwise telemetry uses `SQLITE_PATH`. Redis (`REDIS_URL` `redis://`|`rediss://`) remains optional with bounded local fallback (5k keys `src/persistence/coordination.ts` + 15s TTL cache `src/persistence/telemetry/cache/redis.ts` `ohmyomop-router:telemetry:cache:*` + `LPUSH ohmyomop-router:telemetry:stream`). `TRUST_PROXY` ownership is `src/api/guard.ts` (`isTrustProxyEnabled`/`clientIpOf`/`clientIpForBan` with `CACHED_TRUST_PROXY` snapshot plus dynamic `Bun.env` read) — when trusted, first valid `x-forwarded-for` IP is used, otherwise only `x-real-ip` (both validated via `isIpLiteral`); `clientIpForBan` additionally falls back to `remoteAddress`/`ip` or `127.0.0.1`. `HOST` defaults `0.0.0.0` via `parseHost`; `APP_SECRET_PREV` is only consulted on decrypt failure for key rotation.

## Bounded request and stream limits

```dotenv
OHMYOMOP_ROUTER_MAX_REQUEST_BODY_BYTES=10485760   # 10MiB [64KiB-64MiB] fallback 10MiB, enforced per-request via src/api/guard.ts:computeBodyLimit() (clamped 64KiB-64MiB; CACHED_BODY_LIMIT is deprecated snapshot)
OHMYOMOP_ROUTER_MAX_STREAM_LINE_BYTES=65536       # 64KiB [4KiB-64KiB] effective hard cap src/proxy/transport/sse.ts:MAX_SSE_LINE
OHMYOMOP_ROUTER_MAX_STREAM_EVENT_BYTES=65536      # 64KiB [4KiB-64KiB] effective hard cap MAX_SSE_EVENT
OHMYOMOP_ROUTER_MAX_STREAM_BUFFERED_BYTES=524288  # 512KiB [64KiB-512KiB] effective hard cap MAX_SSE_BUFFERED
OHMYOMOP_ROUTER_MAX_STREAM_BYTES=10485760         # 10MiB [1MiB-64MiB] cumulative stream-byte cap
OHMYOMOP_ROUTER_MAX_STREAM_EVENTS=100000          # [1k-100k] effective hard cap MAX_SSE_EVENTS
OHMYOMOP_ROUTER_MAX_ROUTE_TRANSITION_ROUTES=4096    # [16-100k]
OHMYOMOP_ROUTER_MAX_ROUTE_TRANSITIONS_PER_ROUTE=512 # [8-4096]
```

Runtime limits are parsed as integers and clamped in `src/runtime/runtime.ts` `boundedIntegerFromEnv`/`resolveLimits` and `src/runtime/limits.ts`, with effective stream caps enforced by `src/proxy/transport/sse.ts` (`MAX_SSE_LINE`/`MAX_SSE_EVENT` 64KiB, `MAX_SSE_BUFFERED` 512KiB, `MAX_SSE_EVENTS` 100k). Raw `src/runtime/limits.ts` allows larger stream ranges (e.g. 8MiB line) but `STREAM_BOUNDS` caps them to the task-spec hard limits via `Math.min(..., MAX_SSE_*)` — env overrides can narrow but never exceed 64KiB/512KiB/100k. The production body fallback is 10 MiB and is enforced per-request by `src/api/guard.ts` `computeBodyLimit()` (not the deprecated `CACHED_BODY_LIMIT` snapshot). Stream limits also include `OHMYOMOP_ROUTER_MAX_STREAM_FRAMES_PER_PUSH` [32-4096], `OHMYOMOP_ROUTER_MAX_STREAM_FRAMES_PER_EVENT` [64-8192], and `OHMYOMOP_ROUTER_MAX_STREAM_BYTES` 10MiB [1MiB-64MiB] as cumulative-byte guard. `OHMYOMOP_ROUTER_MAX_STREAM_BYTES` as a docs ghost referred to the wrong name — use `OHMYOMOP_ROUTER_MAX_STREAM_BUFFERED_BYTES` for buffered cap; `maxStreamBytes` remains a separate cumulative guard in `STREAM_BOUNDS`. The request also has fixed bootstrap defaults for connect, first-body, idle, and total timeout; the total timeout covers all provider retries.

`OHMYOMOP_ROUTER_REQUEST_LOGS` (`src/runtime/runtime.ts:requestLoggingEnabled` — `!== "0"` enables, default enabled) is the request-log toggle; `.env.example` exposes it as `#OHMYOMOP_ROUTER_REQUEST_LOGS=0` (commented `0` disables). When enabled, console request logging pipelines use `src/persistence/telemetry/*`.

## Memory, telemetry and overhead

```dotenv
OHMYOMOP_ROUTER_TELEMETRY_CACHE_MB=32              # clamp 4-256 → PRAGMA cache_size=-MB*1024 per src/persistence/telemetry/store/sqlite/connection.ts
OHMYOMOP_ROUTER_MAX_TRACKED_IPS=0
OHMYOMOP_ROUTER_MAX_TRACKED_KEYS=0
OHMYOMOP_ROUTER_LOGIN_MAX_TRACKED_IPS=0
OHMYOMOP_ROUTER_GC_INTERVAL_MS=600000
OHMYOMOP_ROUTER_OVERHEAD_TRACKING=1
OHMYOMOP_ROUTER_OVERHEAD_SAMPLE_RATE=1
OHMYOMOP_ROUTER_OVERHEAD_SAMPLES_PER_PHASE=8192
OHMYOMOP_ROUTER_OVERHEAD_STREAM_SAMPLE_RATE=0.01
OHMYOMOP_ROUTER_DNS_CACHE_TTL_MS=60000
OHMYOMOP_ROUTER_HEDGE_DELAY_MS=300
```

`OHMYOMOP_ROUTER_TELEMETRY_CACHE_MB` defaults to 32 MiB and is clamped 4-256 → `PRAGMA cache_size=-MB*1024` per `src/persistence/telemetry/store/sqlite/connection.ts`. Telemetry capture is always bounded; overhead sampling controls retained measurements, not request correctness (`src/runtime/overhead.ts`: up to 64 marks per request, up to 64 phases retained via LRU, ~13 hot phases instrumented; `OHMYOMOP_ROUTER_OVERHEAD_SAMPLES_PER_PHASE` clamped 128-65536 default 8192). `OHMYOMOP_ROUTER_MAX_TRACKED_IPS/KEYS/LOGIN` default 10000, `OHMYOMOP_ROUTER_GC_INTERVAL_MS` 600000, plus `OHMYOMOP_ROUTER_OVERHEAD_TRACKING/SAMPLE_RATE/SAMPLES_PER_PHASE/STREAM_SAMPLE_RATE`, `OHMYOMOP_ROUTER_DNS_CACHE_TTL_MS`, `OHMYOMOP_ROUTER_HEDGE_DELAY_MS`. Optional commented values `0` in `.env.example` mean adaptive/unbounded in docs shorthand — runtime clamps to documented defaults (10000/600000) when `0` or missing.

## Server bind

```dotenv
HOST=0.0.0.0
```

`HOST` defaults to `0.0.0.0` via `parseHost` in `src/runtime/runtime.ts` (max 255 chars, empty → `0.0.0.0`). Listed in `.env.example` under “Server bind” as a commented override; `PORT` is mandatory and bounded 1-65535 via `boundedPort`.

## Routing transitions

```dotenv
OHMYOMOP_ROUTER_MAX_ROUTE_TRANSITION_ROUTES=4096    # [16-100k]
OHMYOMOP_ROUTER_MAX_ROUTE_TRANSITIONS_PER_ROUTE=512 # [8-4096]
```

Owned by `src/runtime/runtime.ts:resolveLimits` (`boundedIntegerFromEnv` 4096/512 defaults) and `src/runtime/limits.ts:runtimeMemoryLimits`. Also grouped under “Bounded request and stream limits” above; `.env.example` duplicates them under “Routing transitions” for operator visibility. Clamped per-request via `boundedIntegerFromEnv`; used by `src/proxy/routing/*` transition guards.

## Login tracking

```dotenv
OHMYOMOP_ROUTER_LOGIN_MAX_TRACKED_IPS=10000  # [0-1_000_000], 0=adaptive fallback to 10000
```

Owned by `src/runtime/runtime.ts:resolveLimits` and `src/runtime/limits.ts`. Shares the same clamp as `OHMYOMOP_ROUTER_MAX_TRACKED_IPS/KEYS` (default 10000, clamped 0-1_000_000 via `boundedIntegerFromEnv`). `.env.example` exposes it under “Login tracking” (`#OHMYOMOP_ROUTER_LOGIN_MAX_TRACKED_IPS=10000`); `ENVIRONMENT.md` previously listed it only inside the memory block — now explicit. Consumed by login/IP-ban tracking in `src/persistence/repositories/security.ts` + `src/api/guard.ts`.

## Global rate limit

```dotenv
OHMYOMOP_ROUTER_RATE_LIMIT_MAX_REQUESTS=100  # [1-1_000_000] fallback 100
OHMYOMOP_ROUTER_RATE_LIMIT_WINDOW_MS=60000   # [1_000-86_400_000] fallback 60000 (60s)
```

Owned by `src/runtime/runtime.ts:resolveLimits` and `src/runtime/limits.ts:runtimeMemoryLimits` (`boundedIntegerFromEnv` 100 / 60000). `.env.example` lists them under “Global rate limit” as commented overrides (`#OHMYOMOP_ROUTER_RATE_LIMIT_MAX_REQUESTS=200` / `#OHMYOMOP_ROUTER_RATE_LIMIT_WINDOW_MS=60000` in the template — runtime default is 100/60000, template shows a common operator override). Not to be confused with per-IP `BRUTEFORCE_*/SUSPICIOUS_*/OPEN_ENDPOINT_RATE_LIMIT_PER_MIN/CONSOLE_RATE_LIMIT_PER_MIN` in “Security and rate limits” which are `src/api/guard.ts` + `src/persistence/repositories/security.ts`.

## Memory-constrained mode

```dotenv
OHMYOMOP_ROUTER_LOW_MEM=false  # "1" | "true" (case-insensitive) → low-mem
```

Owned by `src/persistence/pool.ts` (`isLowMem` check: `=== "1"` or `toLowerCase()==="true"`). When enabled, pool defaults trim `max 20 → 10` and cap `maxUpper 50 → 10` to fit small instances. Clamp helper is `Math.min(hi, Math.max(lo, floor(v)))`. `.env.example` default `#OHMYOMOP_ROUTER_LOW_MEM=false`. Unrelated to `OHMYOMOP_ROUTER_TELEMETRY_CACHE_MB` which tunes SQLite `PRAGMA cache_size`.

## WireGuard WARP toggle

```dotenv
OHMYOMOP_ROUTER_ENABLE_WARP=false  # "1" enables POST /console/api/wireguard/warp/create
```

Owned by `src/console/api.ts:warp/create` guard (`if (Bun.env.OHMYOMOP_ROUTER_ENABLE_WARP !== "1") return 404`). `.env.example` default `#OHMYOMOP_ROUTER_ENABLE_WARP=false`. When `"1"`, the console route spawns `bun run scripts/warp-generate.ts` (which itself reads `WARP_API_URL`, `WARP_MTU`, `GOMEMLIMIT/GOGC` — warp-only, not Bun proxy env). See also `WIREPROXY_BIN`/`WIREGUARD_CONFIG_DIR`/`WIREGUARD_START_PORT` under “WireGuard pool”.

## Codex proxy toggle

```dotenv
OHMYOMOP_ROUTER_CODEX_PROXY=true  # "true" enables Codex upstream path
```

Owned by `src/proxy/request/attempt.ts:CODEX_PROXY_ENABLED` (`Bun.env.OHMYOMOP_ROUTER_CODEX_PROXY === "true"` — string equality, unset → disabled). `.env.example` default `#OHMYOMOP_ROUTER_CODEX_PROXY=true`. Gates the Codex provider path; other providers unaffected. Unified to `Bun.env` per Phase 1.6 (was `process.env`).

## Security and rate limits

```dotenv
BRUTEFORCE_MAX_FAILURES=10
BRUTEFORCE_BAN_DURATION_MS=21600000
SUSPICIOUS_MAX_FAILURES=10
SUSPICIOUS_BAN_DURATION_MS=1800000
OPEN_ENDPOINT_RATE_LIMIT_PER_MIN=500
CONSOLE_RATE_LIMIT_PER_MIN=200
```

`TRUST_PROXY` gates `clientIpOf`/`clientIpForBan` in `src/api/guard.ts` (`x-forwarded-for` first-valid-IP when trusted else `x-real-ip`, validated via `isIpLiteral`; `CACHED_TRUST_PROXY` snapshot plus dynamic `Bun.env` read). `BRUTEFORCE_*/SUSPICIOUS_*` via `src/persistence/repositories/security.ts` + `src/runtime/runtime.ts`. Provider API keys are managed through the console, not stored as provider-specific `.env` values.

## WireGuard pool (Go sidecar, not Bun proxy)

```dotenv
WIREPROXY_BIN=./bin/wireproxy.exe
WIREGUARD_CONFIG_DIR=./data/wireguard
WIREGUARD_START_PORT=11080
```

These `.env.example` values configure the Go sidecar (`vendor/wireproxy` + `src/bootstrap/proxy-port.ts` wiring); they are not required by the Bun proxy process. `WIREPROXY_BIN` defaults to `./bin/wireproxy.exe` on Windows (as in `.env.example`) and `./bin/wireproxy` on Unix — `src/console/api.ts` falls back to `./bin/wireproxy.exe` when unset; use the platform-appropriate path. `OHMYOMOP_ROUTER_URL` is not in `.env.example` — sidecar wiring uses `src/bootstrap/proxy-port.ts` directly. Warp-specific `WARP_API_URL=https://api.cloudflareclient.com/v0a737/reg` + `WARP_MTU=1280` + `GOMEMLIMIT/GOGC` belong to `scripts/warp-generate.ts` only.

## Removed legacy variables

Do not add `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `CONSOLE_JWT_SECRET`, `CREDENTIAL_ENCRYPTION_KEY`, `BOOTSTRAP_PROXY_API_KEY`, `BOOTSTRAP_PROXY_API_KEY_NAME`, or `TELEMETRY_TURSO_*` (no code path — `.env` priority comment stale, runtime only checks `TELEMETRY_D1_*` per `src/runtime/runtime.ts` + `src/persistence/telemetry/pipeline.ts`). They are not runtime configuration paths.

## Version check

```sh
bun run version:check
bun run version:sync
```

The checked version is currently `2.1.0-beta`.

## Reproduce environment validation

Validate the version and runtime configuration locally:

```sh
bunx tsc --noEmit
bun run version:check
bun run scripts/dev/doctor.ts
```

`version:check` confirms the three version sources (`package.json`, `dashboard/package.json`, `src/runtime/runtime.ts` via `scripts/dev/sync-versions.ts`) match `2.1.0-beta`. `doctor.ts` reports Bun/platform information (`Bun >=1.4`), required environment variables, PostgreSQL connectivity (`Bun.SQL` SELECT1 8s), migration status (`--status` 15s), and optional Redis PING 5s (`Bun.RedisClient`). It may report a database warning when PostgreSQL is intentionally unavailable (verify tolerates fallback `postgres://ohmyomop_router:ohmyomop_router@127.0.0.1:5432/ohmyomop_router` via `scripts/dev/verify.ts`); it must not be treated as a successful readiness check.

## 2. Persistence

## Authority split

```text
PostgreSQL  → configuration, credentials, routing, security, quota and migrations
SQLite/D1   → request telemetry, bounded payload artifacts and console logs
Redis       → optional coordination, cache and stream visibility; not durable authority
```

`DATABASE_URL` is mandatory. `SQLITE_PATH` is the local telemetry default. D1 is selected only when both `TELEMETRY_D1_URL` and `TELEMETRY_D1_TOKEN` are present.

## PostgreSQL layout

```text
src/persistence/
├─ pool.ts                 connection/readiness and redacted diagnostics
├─ migrate.ts              schema migrations and advisory lock
├─ crypto.ts               APP_SECRET-derived credential encryption
├─ backup.ts               bounded configuration backup/restore
├─ coordination.ts         Redis/local revision, rate and in-flight coordination
├─ types.ts                persistence DTOs
├─ persistence-contracts.ts repository contracts
├─ repositories/           accounts, API keys, settings, proxies, routing config,
│                          filter rules, CLI tools, security and quota
├─ drizzle/pg/             Drizzle PG artifacts (20 SQL + meta/_journal.json, migrate.ts via readMigrationFiles + advisory lock 727727 SHA256 contiguous 1..20)
├─ runtime/quota-worker.ts background provider quota refresh
└─ telemetry/              pipeline, stores, ring buffer, cache and retention
```

`APP_SECRET` is the only credential-encryption source. There is no `CONSOLE_JWT_SECRET`, `CREDENTIAL_ENCRYPTION_KEY`, or `BOOTSTRAP_*` fallback.

Migrations run through the PostgreSQL pool with advisory lock `727727`. `src/persistence/migrate.ts` loads the Drizzle journal and SQL artifacts in `drizzle/pg/` with `readMigrationFiles()`, normalizes their sequential `001`–`020` tags into the existing `schema_migrations` ledger, validates SHA-256 checksums and contiguous versions, and runs each migration transactionally under `pg_advisory_lock/unlock`. Verify `drizzle/pg/meta/_journal.json` and the 20 SQL artifacts with `bun run doctor`. PostgreSQL readiness is part of `/health/ready`. Configuration repository mutations invalidate the local route snapshot immediately; multi-instance revision publication is supplied by the coordination boundary when configured (`src/bootstrap/persistence.ts` concurrent `ping + runMigrations + createTelemetryPipeline + createCoordination` → `coordination.kind ……

## Telemetry pipeline

`src/persistence/telemetry/pipeline.ts` owns a bounded ring and one shared flush promise:

- default queue cap: 5,000 events and 1 MiB estimated event bytes (`DEFAULT_MAX_RECORDS`/`DEFAULT_MAX_BYTES`);
- batches are written in chunks of 500 (`CHUNK_SIZE`);
- eager flush 100 records / 256 KiB (`EAGER_FLUSH`);
- retry caps `LOG_RETRY_CAP 2000` / `PAYLOAD_RETRY_CAP 1000`;
- concurrent `flush()` calls await the active write;
- failed batches are requeued into the bounded ring with drop-oldest accounting;
- shutdown stops timers, waits for active flushes, performs bounded 3 retries, then closes the store;
- query results use typed telemetry rows and cursor pagination;
- retention is incremental and yields between delete chunks.

Pipeline stats expose pending records/bytes, flush count, dropped records, degraded state, write failures, retrying records, and last failure time.
Store selection: `if (d1Url && d1Token) D1TelemetryStore else SqliteTelemetryStore` per `pipeline.ts:68` — `SQLITE_PATH` default `./data/telemetry.db` (`runtime.ts:284`), D1 is `D1TelemetryStore` HTTP batch bearer token.

## SQLite store

SQLite is the default local telemetry backend. It uses WAL and `synchronous=NORMAL`. The cache is file-backed and configurable through `OHMYOMOP_ROUTER_TELEMETRY_CACHE_MB` (default 32 MiB, clamped 4-256 → `PRAGMA cache_size=-MB*1024` per `src/persistence/telemetry/store/sqlite/connection.ts:14`). The store also sets `temp_store=FILE`, `wal_autocheckpoint=1000`, `journal_size_limit=67108864`, `busy_timeout=5000`, `auto_vacuum=INCREMENTAL`.

The schema contains:

- `request_events` — request/provider status, usage, timings and safe metadata;
- `request_payloads` — four bounded artifacts: client/provider request and provider/client response;
- `console_logs` — level, scope, timestamp and sanitized message.

The telemetry schema also carries indexes that match the real dashboard access paths: `request_events(trace_id)`, `request_events(created_at)`, `request_events(provider)`, `request_events(model)`, `request_events(api_key_id)`, and `console_logs(id, scope)`.

Payload capture is capped at 16 KiB, records `truncated`, `originalBytes`, and `capturedBytes`, and redacts credential/token material before storage.

## D1 store

D1 uses the same `TelemetryStore` contract and sends bounded batch statements over the configured HTTP endpoint when both `TELEMETRY_D1_URL`+`TELEMETRY_D1_TOKEN` present (else SQLite per `pipeline.ts:68`). It supports request-event writes/queries, summary/chart/breakdown/cache/trace aggregates, payload save/get, console log writes/queries/ordered streaming, and bounded retention deletes. D1 does not silently fall back to PostgreSQL or return fake empty-success results for unsupported operations.

## Redis

`REDIS_URL` (`redis://`|`rediss://`) is optional. The telemetry cache uses Redis when available (`src/persistence/telemetry/cache/redis.ts` `ohmyomop-router:telemetry:cache:*` 15s TTL + `scan+del` invalidate + `LPUSH ohmyomop-router:telemetry:stream LTRIM 0,9999`) and falls back to bounded in-memory `NoopCache` when no URL or `ping` fails. Coordination (`src/persistence/coordination.ts` `MAX_LOCAL_KEYS 5000` bounded `Map`, `incrRateCounter/incrInFlight` with TTL, `createRedisCoordination` → `degraded:true` fallback to `createLocalCoordination` on ping fail). Redis failure marks `pipeline stats degraded` but does not turn Redis into the durable event store.

## Backups and retention

`src/persistence/backup.ts` (`BACKUP_TABLES` 19, `CURRENT_BACKUP_VERSION` 2 in `src/persistence/types.ts:184`, `MAX_BACKUP_BYTES` 64 MiB, `MAX_ROWS_PER_TABLE` 100 000, `TABLE_COLUMNS` allowlist, streaming `BATCH_SIZE` 500) backs up PostgreSQL configuration data with bounded per-table work: `settings, api_keys, share_links, provider_accounts, provider_account_health, account_model_locks, provider_models, model_aliases, combos, custom_providers, proxies, proxy_health, proxy_settings, access_rules, console_sessions, cli_tools, cli_mappings, filter_rules, ip_bans` (excludes ephemeral `provider_account_quota` (quota cache, recreatable via refresh), telemetry SQLite/D1, `warp`/`security_offenses`/`request_payloads` dropped). Telemetry is intentionally excluded from PostgreSQL backups because SQLite/D1 is its authority.

Two export paths emit the same versioned JSON envelope `{ app:"ohmyomop-router", version:2, exportedAt, tables }`:

- `exportBackup(pool)` — in-memory `BackupPayload`; single `SELECT <allowlisted columns> FROM <table> LIMIT 100000` per table (bounded allowlist `TABLE_COLUMNS`); retained for callers/tests that need the object shape.
- `exportBackupStream(pool)` — incremental `Response` (`content-type: application/json; charset=utf-8`, `content-disposition: attachment; filename="ohmyomop-router-backup.json"`, `cache-control: no-store`); paginates each table with `OFFSET/LIMIT 500` batches, streams `tables:{...}` chunks via `ReadableStream`, enforces `MAX_BACKUP_BYTES` while emitting (tracks encoded byte length, calls `controller.error` and terminates before an oversized response). The HTTP download path is `POST /console/api/settings/backup` → `src/console/services/backup.ts:createBackupService` → `exportBackupStream()` after `verifyPassword`. Callers that need the object shape should use `exportBackup()`.

Restore validation (`validateRestorePayload`) rejects unknown `app`, unsupported `version` (must be 2), `JSON.stringify(payload).length > MAX_BACKUP_BYTES`, and invalid rows per `normalizeRows`; `applyRestore(pool, validation)` deletes/inserts in `DELETE_ORDER`/`INSERT_ORDER` within a transaction. Verify limits via `grep -rn "MAX_BACKUP_BYTES\|MAX_ROWS_PER_TABLE\|BATCH_SIZE" src/persistence/backup.ts` and `src/persistence/backup.test.ts:enforces MAX_BACKUP_BYTES during streaming`.

Telemetry retention (`src/persistence/telemetry/retention.ts`, invoked via the pipeline) is batched and yielding:

- `RETENTION_BATCH` 500 rows per `DELETE ... LIMIT 500`, `MAX_CHUNKS_PER_RUN` 8 chunks per invocation, `await Bun.sleep(0)` between chunks to yield.
- Cutoffs: `request_events.created_at` and `console_logs.ts` at 30 days, `request_payloads.updated_at` at 7 days (ISO `YYYY-MM-DD HH:mm:ss` cutoff).
- `console_logs` additionally capped to `MAX_CONSOLE_ROWS` 10 000 newest (`SELECT id ... ORDER BY id DESC LIMIT 1 OFFSET 10000` → `DELETE ... WHERE id <= ? LIMIT 500` loop, up to 8 chunks).
- Verify via `read src/persistence/telemetry/retention.ts` and `bun test src/persistence/telemetry --timeout 60000`.

## Reproduce persistence behavior

Run the store parity and pipeline reliability tests:

```sh
bun test src/persistence/telemetry/store/aggregate-parity.test.ts \
  src/persistence/telemetry/pipeline.test.ts \
  --timeout 60000
```

These tests exercise SQLite and a mocked D1 HTTP endpoint. They verify request-event writes, payload save/get, console-log write/query/stream, retention statements, concurrent flush/shutdown, failed-write requeue, drop accounting, and SQLite PRAGMA settings.

To inspect a local SQLite file after starting the server, use any SQLite client:

```sql
PRAGMA journal_mode;
PRAGMA synchronous;
PRAGMA temp_store;
PRAGMA wal_autocheckpoint;
PRAGMA journal_size_limit;
PRAGMA cache_size;
SELECT COUNT(*) FROM request_events;
SELECT COUNT(*) FROM console_logs;
```

Expected defaults are WAL, `synchronous=NORMAL`, `temp_store=FILE`, auto-checkpoint `1000`, journal limit `67108864`, and a negative cache size corresponding to the configured MiB value.

Payload records must report `truncated`, `originalBytes`, and `capturedBytes`; their stored text must not contain bearer/API-key material.

Capture-specific reproduction:

```sh
bun test src/proxy/request/capture.test.ts --timeout 60000
```

The test feeds a multi-megabyte secret-bearing value and tees a multi-megabyte provider response. It verifies that the response still reaches the caller, persisted capture stays at or below 16 KiB, `truncated` is true, the original byte count remains large, and secrets after the capture boundary are absent from stored text.

## 3. Performance

Oh My Omop - Router measures attributable local overhead separately from provider latency. Provider TTFT, upstream queueing and remote rate limits are not local SLO guarantees.

## Overhead tracking

`src/runtime/overhead.ts` uses request-scoped async storage (`AsyncLocalStorage`) with up to 64 marks per request (`MAX_MARKS_PER_REQUEST`) and up to 64 distinct phases retained (`MAX_PHASES`, LRU eviction; `RollingSamples` per phase, `DEFAULT_SAMPLES_PER_PHASE` 8192, clamped 128-65536 via `OHMYOMOP_ROUTER_OVERHEAD_SAMPLES_PER_PHASE`). Roughly ~13 hot path phases are instrumented in practice (ingress, auth/body, token estimation, route snapshot/plan/attempt/refresh, compression ponytail/RTK, protocol normalization, provider discovery `cursor`/`devin` inline, upstream DNS/fetch, stream framing, telemetry enqueue) but any `PHASE_PATTERN`-valid phase up to 64 may be recorded. Sampling controlled via `OHMYOMOP_ROUTER_OVERHEAD_TRACKING`/`SAMPLE_RATE`/`SAMPLES_PER_PHASE`/`STREAM_SAMPLE_RATE` + `OHMYOMOP_ROUTER_DNS_CACHE_TTL_MS`/`HEDGE_DELAY_MS`.

Sampling can be disabled or reduced through environment overrides. When disabled, the hot path avoids retaining phase reports.

## Endpoints

- `GET /health/overhead` — API-key authenticated overhead and telemetry snapshot.
- `GET /metrics` — API-key authenticated Prometheus exposition.
- Console performance endpoints mirror the same runtime snapshots behind the console session.

The dashboard polls performance data and displays percentile/max values per phase. Treat these values as local observations for the running process, not provider latency measurements.

## Dashboard hot paths

The dashboard keeps its busiest surfaces on shared, cached data paths instead of child-level fanout:

- the Usage page loads one snapshot family for summary, chart buckets, breakdown rows, cache summary, and recent requests; the request table is windowed and the detail drawer reuses cached rows when present;
- Console Log keeps lines newest-first, dedupes by `id`, precomputes searchable blobs, and defers the search term so typing does not re-filter the same string work on every keystroke;
- the shared API response parser reads the body once, the time tick scheduler sleeps when hidden, and the model picker virtualizes large option lists instead of rendering everything at once.

## Bounded memory and streaming

Performance protections are correctness boundaries:

- request bodies are capped by `OHMYOMOP_ROUTER_MAX_REQUEST_BODY_BYTES` 10MiB [64KiB-64MiB], enforced per-request via `src/api/guard.ts` `computeBodyLimit()` (clamped 64KiB-64MiB, fallback 10MiB; `CACHED_BODY_LIMIT` is a deprecated frozen snapshot);
- SSE line/event/buffer/event-count/cumulative-byte limits are bounded and clamped — effective hard caps `MAX_SSE_LINE` 64KiB / `MAX_SSE_EVENT` 64KiB / `MAX_SSE_BUFFERED` 512KiB / `MAX_SSE_EVENTS` 100k per `src/proxy/transport/sse.ts` (`STREAM_BOUNDS` caps env overrides via `Math.min(..., MAX_SSE_*)` so env [4KiB-64KiB]/[64KiB-512KiB]/[1k-100k] can narrow but never exceed task-spec caps; raw `src/runtime/limits.ts` allows larger ranges but is capped). Additional guards: `OHMYOMOP_ROUTER_MAX_STREAM_FRAMES_PER_PUSH` [32-4096], `OHMYOMOP_ROUTER_MAX_STREAM_FRAMES_PER_EVENT` [64-8192], `OHMYOMOP_ROUTER_MAX_STREAM_BYTES` 10MiB [1MiB-64MiB] cumulative;
- public stream pulls respect `ReadableStream.desiredSize`;
- payload capture stores at most 16 KiB plus one bounded capture chunk;
- telemetry uses a bounded ring 5k/1MiB chunk 500 eager 100/256KiB LOG 2000/PAYLOAD 1000 (`src/persistence/telemetry/pipeline.ts`), shared flush ownership and bounded degraded retries;
- SQLite defaults to a 32 MiB configurable page cache (`OHMYOMOP_ROUTER_TELEMETRY_CACHE_MB` clamp 4-256 → `PRAGMA cache_size=-MB*1024`) and `temp_store=FILE` `wal_autocheckpoint=1000` `journal_size_limit=67108864` (`src/persistence/telemetry/store/sqlite/connection.ts`), not a 256 MiB memory cache;
- route/session and API-key caches have explicit TTL/capacity boundaries.

## Tuning

Useful overrides are documented in [Environment](./ENVIRONMENT.md): overhead sampling, DNS cache TTL, hedge delay, request/stream limits, telemetry cache size, tracked-IP/key caps and GC interval. Change one boundary at a time and compare `/health/overhead`, `/metrics`, telemetry queue stats and process memory.

## Load exercise

When `scripts/k6-overhead.ts` is available in the checkout, use it against a running local instance with a test API key. Run non-streaming and streaming workloads separately; streaming tests must include slow consumers to validate desired-size gating and cancellation rather than measuring only provider latency.

## Reproduce bounded behavior

Run the focused deterministic suite:

```sh
bun test src/proxy/transport/sse.test.ts \
  src/proxy/transport/sse.test.ts \
  src/proxy/surface.test.ts \
  src/proxy/request/capture.test.ts \
  src/persistence/telemetry/pipeline.test.ts \
  --timeout 60000
```

Observe runtime overhead with a running server:

```sh
curl -sS http://127.0.0.1:12800/health/overhead \
  -H "x-api-key: $PROXY_API_KEY" | jq .
curl -sS http://127.0.0.1:12800/metrics \
  -H "x-api-key: $PROXY_API_KEY"
```

For a manual slow-consumer check, use `curl -N` without piping to a fast parser and watch provider/network telemetry. The public adapter must stop pulling when `desiredSize <= 0`; client cancellation must cancel the provider iterator. The deterministic surface-stream test covers this without a live provider.

## 4. Deployment (cross-OS)

### One-command setup

```sh
bun run setup        # unified cross-OS: .env ensure -> infra:up (Docker or local PG) -> db:migrate -> doctor
# aliases (same flow):
bun run setup:win    # Windows / Laragon
bun run setup:mac    # macOS / Homebrew
bun run setup:linux  # Linux / systemd
bash ./scripts/unix/setup.sh  # thin wrapper for macOS/Linux
```

| OS | Docker available | Docker unavailable (local fallback) |
|---|---|---|
| Windows | `docker compose up -d --wait` -> `postgres:16-alpine` | Laragon Start All / `net start postgresql-x64-16`, `DATABASE_URL` host `127.0.0.1:5432` |
| macOS | same | `brew services start postgresql@16` (auto-tried by infra:up), `lsof -i :5432` |
| Linux | same | `sudo systemctl start postgresql`, `pg_isready -h 127.0.0.1 -p 5432` |

`scripts/infra.ts` detects `docker compose` vs `docker-compose`, otherwise runs OS-aware `runLocalUp()` via `scripts/dev/_shared.ts` (`isWindows`/`isMacOS`/`isLinux`, `localPostgresHints()`, `tryAutoStartLocalPostgres()` best-effort for brew).

## Build & compose

- `Dockerfile` (`bun build --compile --minify --bytecode --target bun --outfile /out/ohmyomop-router src/main.ts`) + `docker-compose.yml` (`12800:8080`, container `PORT=8080` / `EXPOSE 8080`, host `12800`) + `docker-entrypoint.sh` — `PUBLIC_ORIGIN`, `DATABASE_URL`, `APP_SECRET`, `PROXY_API_KEY`, optional `SQLITE_PATH` default `./data/telemetry.db` (SQLite telemetry only; D1 when both `TELEMETRY_D1_URL`+`TELEMETRY_D1_TOKEN`).
- Version lockstep `package.json` + `dashboard/package.json` + `src/runtime/runtime.ts:OHMYOMOP_ROUTER_VERSION` via `scripts/dev/sync-versions.ts` (`bun run version:check`/`sync`).

## Pre-flight validation

```sh
bunx tsc --noEmit
bun run version:check
bun run scripts/dev/doctor.ts   # or: bun run scripts/dev/verify.ts (tsc + legacy grep 0 + build + doctor with DB warning ok)
```

`scripts/dev/doctor.ts` via `scripts/dev/_shared.ts`: platform `Bun >=1.4` (checked via `Bun.version`/`process.platform`/`process.arch`, `Bun.spawn` argument arrays, `node:path`, Windows-safe — no Bash/`uname`/`whoami`/`grep`/`sed`), `compose file` existence, `src/persistence/migrate.ts` + `drizzle/pg` 20 artifacts, Docker variant detection (`docker compose` vs `docker-compose`), `DATABASE_URL` `Bun.SQL` `SELECT 1` 8s, `REDIS_URL` `Bun.RedisClient` PING 5s, `migrations --status` 15s (`src/persistence/migrate.ts --status` advisory lock `727727`). `scripts/dev/verify.ts` tolerates absent DB via fallback `postgres://ohmyomop_router:ohmyomop_router@127.0.0.1:5432/ohmyomop_router` (doctor warning, not `ready`); direct `doctor` without `DATABASE_URL` fails `DATABASE_URL` validation. `T…

## Runtime bootstrap (`src/bootstrap/*`)

```text
bootstrap/bootstrap.ts → loadRuntimeConfig (src/runtime/runtime.ts) + pool/migrations/readiness (src/persistence/pool.ts + migrate.ts) + coordination (src/persistence/coordination.ts redis|local 5k keys, degraded flag) + telemetry pipeline (src/persistence/telemetry/pipeline.ts D1 iff both TELEMETRY_D1_URL+TOKEN else SQLite WAL/NORMAL cache 32MiB clamp 4-256) + default registry 46 (47 definitions: 10 oauth +37 api_key per `src/providers/registry.ts`/`src/providers/oauth-provider/provider-definitions.ts`/`src/providers/default-registry.ts` 41 eager +5 lazy `codex,claude,antigravity,cursor,devin` →46; `kimi-code` has no eager adapter) + proxy port (src/bootstrap/proxy-port.ts) + public guard (src/api/guard.ts) + console wiring (src/bootstrap/console-wiring.ts)
```

- PostgreSQL: 20 migrations `001_initial` → `020_telemetry_aggregates` contiguous SHA256 `pg_advisory_lock 727727`.
- Coordination: `kind redis|local` from `src/bootstrap/persistence.ts` `createCoordination` (ping fallback → `degraded:true`).
- Telemetry: ring `5000/1MiB` eager `100/256KiB` chunk `500` retry `LOG 2000/PAYLOAD 1000` + `MemoryCache LRU` + Redis `LPUSH` 15s.

## Backup & retention

- `src/persistence/backup.ts` `BACKUP_TABLES 19 v2` `CURRENT_BACKUP_VERSION 2` `MAX_BACKUP_BYTES 64MiB` `MAX_ROWS 100000` allowlist `TABLE_COLUMNS`: `settings, api_keys, share_links, provider_accounts, provider_account_health, account_model_locks, provider_models, model_aliases, combos, custom_providers, proxies, proxy_health, proxy_settings, access_rules, console_sessions, cli_tools, cli_mappings, filter_rules, ip_bans` (excludes `provider_account_quota`, `telemetry` SQLite/D1, dropped `warp`, `security_offenses`, `request_payloads`). Handled via `src/console/services/backup.ts` console API.

## WireGuard sidecar (optional)

- `vendor/wireproxy` (Go, `wireproxy` `wireguard-go` + `gvisor netstack`, 50 tunnels ~500MB) + `scripts/warp-generate.ts` (`@noble/curves` X25519). `.env` `WIREPROXY_BIN`, `WIREGUARD_CONFIG_DIR`, `WIREGUARD_START_PORT`, sidecar-only `GOMEMLIMIT/GOGC`, `OHMYOMOP_ROUTER_URL`. Warp `WARP_API_URL https://api.cloudflareclient.com/v0a737/reg` `WARP_MTU 1280` only for `warp-generate`.

## Reproduce deployment

```sh
bun run scripts/dev/verify.ts   # tsc + legacy grep 0 + `bun build --target bun src/main.ts` + doctor (DB warning ok, Windows-safe Bun.spawn)
bun build --target bun src/main.ts --outfile .tmp-verify-build.js && rm .tmp-verify-build.js  # verify's lightweight build check (Docker production build uses: bun build --compile --minify --bytecode --target bun --outfile /out/ohmyomop-router src/main.ts)
bun test src/persistence/telemetry --timeout 60000
```

For live instance (host `12800` → container `8080`):

```sh
curl -i http://127.0.0.1:12800/health | grep x-ohmyomop-router-version
curl -i http://127.0.0.1:12800/health/ready | jq .ready
curl -sS http://127.0.0.1:12800/health/overhead -H "x-api-key: $PROXY_API_KEY" | jq .telemetry
```

---
_Merged from ENVIRONMENT.md + PERSISTENCE.md + PERFORMANCE.md + DEPLOYMENT.md_
