# Oh My Omop - Router Documentation

**Version:** `2.1.0-beta` — synchronized across `package.json`, `dashboard/package.json`, and `src/runtime/runtime.ts` by `scripts/dev/sync-versions.ts` (verified via `bun run version:check` 3-way lockstep).

## Index

| Document | Scope |
|---|---|
| [Comprehensive](./COMPREHENSIVE.md) | **Single comprehensive** — full Mermaid + ASCII + tables, request flow Client→Guard→Provider→Client detailed, all sections (Architecture/Routing/Translation/Operations/Providers/Quality/API) |
| [Architecture](./ARCHITECTURE.md) | Ownership, request path (Mermaid), routing (detection→mapping→plan), translation (ContentPart/ToolChoice), stream & lifecycle bounds |
| [API](./API.md) | Public proxy, single error envelope (`error.request_id` + `x-request-id`), stream disconnect/bounds, health/metrics/console |
| [Providers](./PROVIDERS.md) | Registry 47 defs + OAuth + discovery + Auth Refresh (leases/CAS/quota) + Proxy Pool + WireGuard + Cache Hit (Mermaid) |
| [Operations](./OPERATIONS.md) | Environment (.env clamp) + Persistence (Postgres/SQLite/D1) + Performance (overhead/bounded queues) + Deployment (Compose/migrations) — Mermaid |
| [Quality](./QUALITY.md) | Security (SSRF/envelope/redaction) + Testing (hybrid colocated + contract) + Troubleshooting (symptom→cause→fix) — Mermaid |

## Quick start (cross-OS)

```sh
cp .env.example .env
bun install
bun run setup        # Docker auto when available, else local PG (Win Laragon / mac brew / linux systemd)
bun run dev:all      # backend 12800 + dashboard 5173
# aliases: bun run setup:win / setup:mac / setup:linux  (all route to scripts/setup.ts)
# or: bash ./scripts/unix/setup.sh  (macOS/Linux thin wrapper)
```

Set `DATABASE_URL`, `APP_SECRET`, `PROXY_API_KEY`, `PORT` (mandatory, fail-fast in `src/runtime/runtime.ts` — `DATABASE_URL` `postgres://` with hostname, `APP_SECRET` ≥32 chars SHA256 `deriveCredentialEncryptionKey`, `PROXY_API_KEY` in production). `SQLITE_PATH` is optional (default `./data/telemetry.db` per `runtime.ts:284`, D1 selected only when both `TELEMETRY_D1_URL`+`TELEMETRY_D1_TOKEN` per `src/persistence/telemetry/pipeline.ts:68` else SQLite). `PUBLIC_ORIGIN`/`DISABLE_LANDING_PAGE` are optional. PostgreSQL is the durable configuration authority. Docker, when available, provides `postgres:16-alpine` + optional `redis:7-alpine`; otherwise the local PostgreSQL is used with OS-aware hints.

Verification commands:

```sh
bunx tsc --noEmit
bun run version:check
bun test src/proxy/events/assembly.test.ts src/proxy/translate/cross-surface.test.ts src/proxy/events/lifecycle.test.ts --timeout 60000
bun test test/request-lifecycle-contract.test.ts --timeout 60000
bun test src --timeout 60000
bun test test --timeout 60000
bun run scripts/dev/verify.ts
bun build --target bun src/main.ts --outfile .tmp-verify-build.js
```

## Source map

```text
src/
├─ main.ts              → bootstrap/bootstrap.ts
├─ bootstrap/           → composition, runtime config, proxy port, console wiring
├─ api/                 → public `/v1/*` boundary, shared guards, single error envelope (`error.request_id` + `x-request-id` + `no-store`)
├─ console/             → authenticated console router and services
├─ proxy/               → single source of truth: types/* + normalize/* + translate/* + events/* + transport/* + routing/* + request/* + upstream/* + policy/*
├─ providers/           → registry 47 defs (10 oauth+37 api_key, 41 eager+5 lazy→46) + catalog/discovery (`fetch-models.ts` + inline `oauth-provider/cursor.ts:GetUsableModels` http2 + `oauth-provider/devin.ts:GetCliModelConfigs` protobuf) + upstream dispatch (`providers/upstream/{openai,anthropic,gemini,adapter,compatibility,protobuf}.ts`) + quota fetch
├─ auth/                → OAuth driver registry, login sessions, refresh and bounded OAuth HTTP
├─ compression/         → Ponytail, RTK, token saving and filter policy
├─ persistence/         → PostgreSQL repositories plus SQLite/D1 telemetry pipeline
└─ runtime/             → limits, admission, concurrency, in-flight state, overhead and version
```

No current ownership depends on `src/application`, `src/codec`, `src/traffic`, `src/proxy/openai.ts` (deleted; split into `protocol/normalize/openai.ts` + `protocol/translate/{request,response}`), duplicate `src/proxy/routing/model-chain.ts` live expansion, duplicate planner/repair, or a PostgreSQL telemetry sink (`src/proxy/transport` IS active).

## Reproduction index

The canonical documents include runnable sections at the bottom of the relevant topic:

| Behavior | Reproduction |
|---|---|
| Public health, JSON/SSE proxy, single error envelope + disconnect | [API → Reproduce locally](./API.md#reproduce-locally) |
| Route invalidation, mapping allowlist, fallback/round-robin, ambiguous-model, capability filter | [Architecture → Routing](./ARCHITECTURE.md#4-routing--detectionmappingplanner) |
| Ordered content/tool-choice/ResponseFormatConstraint, canonical event/outcome, capability projection | [Architecture → Translation](./ARCHITECTURE.md#5-translation--ordered-content--canonical-events) |
| SQLite/D1, retention and payload capture | [Operations → Persistence](./OPERATIONS.md#2-persistence) |
| Provider registry/discovery | [Providers → Registry](./PROVIDERS.md#1-registry--catalog) |
| Cache evidence | [Providers → Cache Hit](./PROVIDERS.md#5-cache-hit) |
| OAuth/API-key auth | [Providers → Auth Refresh](./PROVIDERS.md#2-auth-refresh--quota) |
| Stream/memory/performance bounds + lifecycle gate + disconnect | [Operations → Performance](./OPERATIONS.md#3-performance) |
| Proxy failover | [Providers → Proxy Pool](./PROVIDERS.md#3-proxy-pool) |
| WireGuard sidecar | [Providers → WireGuard](./PROVIDERS.md#4-wireguard-pool) |
| Hybrid tests + request-lifecycle contract (fake upstream) | [Quality → Testing](./QUALITY.md#2-testing) |
| Security, single error envelope, stream bounds & disconnect | [Quality → Security](./QUALITY.md#1-security) |
| Deploy & migrations | [Operations → Deployment](./OPERATIONS.md#4-deployment) |
| Troubleshooting | [Quality → Troubleshooting](./QUALITY.md#3-troubleshooting) |
