# Quality

> Merged: Security + Testing + Troubleshooting — quality, safety, and reproducible checks.

```mermaid
flowchart TD
  Test --> Security --> Troubleshooting
  Security --> SSRF & Envelope & Redaction
  Testing --> Unit & Contract & E2E
```

```text
ASCII: Testing(hybrid colocated + contract) -> Security(SSRF/envelope/bounds) -> Troubleshooting(symptom->cause->fix)
```

## 1. Security

## SSRF & network policy

- `src/proxy/transport/network.ts` rejects private/loopback/CGNAT/data URLs, oversized data URLs, and validates every proxy/upstream URL before `fetch`.
- Token refresh `src/auth/http-client.ts` enforces HTTPS-only (`isHttpsOnly`) + `MAX_TOKEN_RESPONSE_BYTES 42384` + `64KiB` body cap + `SSRF` `validateUrl`.
- `TRUST_PROXY` gates `clientIpOf`/`clientIpForBan` (`x-forwarded-for` first-valid-IP when trusted else `x-real-ip`, validated via `isIpLiteral`) per `src/api/guard.ts` (`isTrustProxyEnabled`/`CACHED_TRUST_PROXY` snapshot plus dynamic `Bun.env` read) — `src/runtime/runtime.ts` does not own `TRUST_PROXY`. Security headers `cache-control: no-store`, `x-request-id` (mirrors `error.request_id`), `x-content-type-options: nosniff`, `x-frame-options: DENY`, CSP, HSTS are applied via `src/api/guard.ts` `applySecurityHeaders`/`SAFE_HEADERS`.

## Public error envelope and stream bounds

- One public error envelope for every HTTP JSON error (`src/api/guard.ts:errorResponse` + `src/proxy/events/lifecycle.ts:writeErrorResponse` + planner/prepare pre-commit failures share a dependency-neutral builder): `{ error: { type: "error", code, message, request_id } }` with matching `x-request-id` + `cache-control: no-store` + security headers (`PublicErrorBody` in `src/proxy/types/error-types.ts`, OpenAPI `error` schema). `request_id` is `ProxyIngressContext.requestId` — `readBoundedJson`, auth/malformed-body, and every `/v1` exit reuse it (no second `randomUUID`). Mapping is typed `ApplicationErrorKind`/`ProxyErrorCode` (`invalid_request`, `ambiguous_model`, `model_not_found`, `capability_unsupported`, `stream_truncated`, etc.) — never provider-substring. Post-commit failures are one legal typed stream terminal per `src/proxy/events/lifecycle.ts:classifyTerminal` + `src/proxy/translate/stream.ts`, not a second HTTP JSON body; `x-request-id` still matches the terminal `request_id`.
- Stream bounds (`src/proxy/transport/sse.ts:STREAM_BOUNDS`) apply inbound and outbound: 64 KiB line, 64 KiB event, 512 KiB buffered, 100k events. Outbound `STREAM_BOUNDS` per-frame + cumulative byte limits apply to Chat, Responses, and Messages (frame-count-only removed); buffer `Buffer.concat`/decoded-accumulation loops in Devin/Cursor/CommandCode adapters use bounded aggregate/frame checks via `STREAM_BOUNDS`. Lifecycle gate (`src/proxy/events/lifecycle.ts` + `src/proxy/types/stream.ts` + `src/proxy/transport/sse.ts:mapSseStream`/`src/proxy/translate/stream.ts:createSurfaceStream`) enforces one start, valid nonempty tool names, each tool closed, at most one usage, one stop, no post-terminal; duplicate/post-terminal → `provider_protocol_error`; fatal UTF-8/malformed framing → `ProviderAdapterError: provider_protocol_error`. `[DONE]` idempotent; EOF without terminal → `stream_truncated`.
- Disconnect abort propagation: `src/api/v1.ts:handleProxy` retains the abort listener through stream completion/cancellation (disposal transfers to the returned stream lifecycle); reader cancellation aborts the fake upstream (`AbortSignal.aborted === true`), stops further source reads, and `createOwnedStream` + `createReleaseGate` release lease/network/capture/telemetry exactly once, joined to `TelemetryFinish`.

## Credential handling & redaction

- `APP_SECRET` sole source `deriveCredentialEncryptionKey` SHA-256 (`src/runtime/runtime.ts` `deriveCredentialEncryptionKey`/`resolveEncryptionPolicy` + `src/persistence/crypto.ts` `resolveEncryptionKey`, `MIN 32` prod). Production placeholder checks: runtime `/(?:^|[^a-z0-9])(?:change-me|replace-with|password)/i` and persistence `/^(?:change-me|replace-with|replace_me|password|secret|default|example)(?:[-_].*)?$/i` — both must not match. No `CONSOLE_JWT_SECRET`/`CREDENTIAL_ENCRYPTION_KEY` fallback. `APP_SECRET_PREV` is optional rotation fallback — `src/persistence/crypto.ts` `decryptWithKey` tries `Bun.env.APP_SECRET_PREV` SHA-256 when primary decryption fails.
- `src/proxy/request/capture.ts` caps payload at 16 KiB (`truncated`, `originalBytes`, `capturedBytes`) and redacts credential/token material before persistence (`src/persistence/telemetry/pipeline.ts`).
- `src/auth/callback-server.ts:REDACT_PATTERNS` + `src/persistence/telemetry/pipeline.ts` ensure `PROXY_API_KEY`, bearer tokens, OAuth `code/verifier/state` never appear in telemetry, console logs, or `GET /health/overhead`/`/metrics`.
- `src/auth/refresher.ts TokenRefreshPool` single-flight + distributed lease CAS (`fingerprint`/`generation`) + `release exactly once` — concurrent requests for one account share same in-flight promise; losing process rereads.

## Rate limits & bans

- `src/persistence/repositories/security.ts` + `src/runtime/runtime.ts` bounded: `BRUTEFORCE_MAX_FAILURES 10 BAN 6h`, `SUSPICIOUS 10 30m`, `OPEN_ENDPOINT 500/min`, `CONSOLE 200/min` (`OPEN_ENDPOINT_RATE_LIMIT_PER_MIN`/`CONSOLE_RATE_LIMIT_PER_MIN`). `OHMYOMOP_ROUTER_MAX_TRACKED_IPS/KEYS/LOGIN 10000`, `OHMYOMOP_ROUTER_GC_INTERVAL_MS 600000`.
- `src/persistence/coordination.ts` `MAX_LOCAL_KEYS 5000` bounded `Map` + TTL eviction.

## OAuth & quota

- 10 drivers `src/auth/driver-registry.ts` (`antigravity`, `claude-code`, `cline`, `cline-pass`, `codex`, `zai-coding-plan`, `kimi-code`, `github-copilot`, `cursor` poll, `devin` `59653/callback`). `resolveAuthDriverCapabilities` derives `supportsStart/Poll/Exchange/Refresh/Revoke/Browser/Device`.
- Quota `src/providers/quota-fetch/fetch.ts:QUOTA_FETCHERS` + `src/bootstrap/quota.ts:supportsProvider` Set 11 (adds `ollama`, `zai` though no driver) — retry caps via `src/auth/refresher.ts (QuotaRefreshWorker) + src/bootstrap/quota.ts`.

## Responsible operator checklist

- Never paste `PROXY_API_KEY`, `APP_SECRET`, OAuth `refresh_token`, `devin-session-token$`, or `WorkosCursorSessionToken` in shell history or docs.
- Keep `DATABASE_URL` `postgres://` with hostname, not `POSTGRES_USER/PASSWORD` separate vars.
- Verify `bun run version:check` + `scripts/dev/doctor.ts` before production.

## Reproduce security

```sh
bun test src/proxy/request/capture.test.ts --timeout 60000
bun test src/proxy/transport --timeout 60000
bun test src/auth --timeout 60000
```

`capture.test.ts` feeds multi-megabyte secret-bearing value + tees response: verifies persisted capture ≤16 KiB, `truncated true`, `originalBytes` large, secrets after boundary absent from stored text. Upstream tests verify SSRF rejects `http://127.0.0.1`/`169.254.x`/`data:` oversize.

## 2. Testing

## Hybrid layout (2026 convention, per AGENTS.md §5.1)

| Layer | Location | Runner | Pattern |
|---|---|---|---|
| Unit | `src/**/*.test.ts` colocated | Bun `bun test` | Co-move/co-delete with implementation |
| Contract/integration | `test/*.test.ts` | Bun `bun test ./test` | Fixtures, DB, network, cross-module |
| Dashboard | `dashboard/test/` mirroring `dashboard/src/` | Vitest `cd dashboard && bun run test` | `jsdom`, `setupFiles ./test/setup.ts`, `globals: false` |

- Naming: `*.test.ts` only — no `*.spec.ts`, no `__tests__/` folders.
- `tsconfig.json`: `include: ["src"]`, `exclude: ["test", "src/**/*.test.ts"]`, `noEmit: true` — Bun runs TS directly; dashboard tests use the dashboard project configuration. Actual `tsconfig.json` is `target ESNext, module ESNext, bundler` (drifts from AGENTS.md prose `NodeNext/es2022` — keep prose tolerant).
- Coverage: `bun test --coverage` (Bun native, not c8/istanbul).

- Counts: do not hardcode — verify via commands (counts drift with co-located files). Use:
  ```sh
  find src -name "*.test.ts" | wc -l; find test -name "*.test.ts" | wc -l; find dashboard/test -name "*.test.ts" | wc -l
  bun test ./src --timeout 60000 2>&1 | tail -n 5   # Ran X tests across Y files
  bun test ./test --timeout 60000 2>&1 | tail -n 5  # Ran 6 tests across 1 file
  cd dashboard && bun run test 2>&1 | tail -n 5     # Test Files ... Tests ...
  ```
  As of this doc, verify via `find` commands above (counts drift as tests are added) — do not hardcode; ground truth is `bun test` tail output.

## Request-lifecycle suites (step 10 contracts, colocated)

| Suite | Covers |
|---|---|
| `src/proxy/upstream/compatibility.test.ts`, `events-repair.test.ts`, `cross-surface.test.ts`, `events-assembly.test.ts` | function vs hosted `web_search`, strict/custom/native/opaque tools, ToolChoice/parallel/format matrices, cross-surface metadata/reasoning ordering/signatures, malformed tool names, every folded extended event, Responses↔Messages non-stream |
| `src/proxy/request/prepare.test.ts`, `routing-reliability.test.ts`, `plan.test.ts`, `request/execute.test.ts` | consecutive missing-result adjacency, single ingress detection/precedence/conflicts, allowlisted/unallowlisted/disabled mapping, trim/case-fold + Claude family, fallback/round-robin/nested/cyclic combos, ambiguous bare IDs (400) vs model_not_found (404), pre-lease capability rejection, 4-identity telemetry, pre/post-commit failures |
| `src/proxy/transport/sse.test.ts`, `protocol/surface.test.ts`, `protocol/events-lifecycle.test.ts`, `protocol/events-assembly.test.ts` | malformed UTF-8, duplicate/post-terminal source data, typed terminal projection for all surfaces, legal Responses extended events, signatures/cache-write usage, outbound `STREAM_BOUNDS` (Chat/Responses/Messages), cancellation, exactly-once cleanup |
| `src/providers/api-key/cline.test.ts`, `api-key/qoder-commandcode.test.ts`, `oauth-provider/devin.test.ts`, `oauth-provider/cursor.test.ts`, `src/proxy/upstream/openai.test.ts` | deterministic upstream chunks → advertised capability ↔ request/canonical-stream/non-stream-fold/terminal/usage parity; Devin/Cursor/CommandCode/Qoder/Cline image/native/reasoning/usage contracts |
| `src/persistence/telemetry/store/aggregate-parity.test.ts`, `src/console/services/observability-aggregate.test.ts` | store-side usage summary/chart/breakdown/cache/trace delegation, SQLite/D1 parity, batched API-key totals, batched quota refresh |
| `test/request-lifecycle-contract.test.ts` | deterministic public Elysia routes with fake pool/telemetry/registry/app composer + body factories — Chat/Responses/Messages stream/non-stream, cross-surface Responses→Messages, hosted search, mapping allowlist, pre-lease capability failure (no lease/provider), unified envelope (`error.request_id` + `x-request-id`), post-handoff stream failure, client cancellation (upstream abort + single release) |

## Dashboard suites

| Suite | Covers |
|---|---|
| `dashboard/test/hooks/use-console-log-stream.test.tsx`, `dashboard/test/features/console-log/page.test.tsx` | newest-first console log dedupe/merge, precomputed search blobs, deferred search, reconnect/highlight timer hygiene |
| `dashboard/test/features/usage/page.test.tsx` | shared usage snapshot family, cached detail drawer first, windowed request table |
| `dashboard/test/lib/api.test.ts`, `dashboard/test/lib/time-tick.test.ts`, `dashboard/test/components/model-picker.test.tsx` | single-read response parsing, visibility-aware tick scheduler, model-picker virtualization |

## Commands

```sh
bunx tsc --noEmit
bun run version:check          # 2.1.0-beta lockstep: package.json + dashboard/package.json + src/runtime/runtime.ts

bun test --timeout 60000 src/proxy/upstream/compatibility.test.ts src/proxy/events/repair.test.ts src/proxy/translate/cross-surface.test.ts src/proxy/events/assembly.test.ts
bun test --timeout 60000 src/proxy/request/prepare.test.ts src/proxy/routing/routing-reliability.test.ts src/proxy/routing/plan.test.ts src/proxy/request/execute.test.ts
bun test --timeout 60000 src/proxy/transport/sse.test.ts src/proxy/translate/surface.test.ts src/proxy/events/lifecycle.test.ts src/proxy/events/assembly.test.ts
bun test --timeout 60000 src/providers/api-key/cline.test.ts src/providers/api-key/qoder-commandcode.test.ts src/providers/oauth-provider/devin.test.ts src/providers/oauth-provider/cursor.test.ts src/proxy/upstream/openai.test.ts
bun test --timeout 60000 ./test/request-lifecycle-contract.test.ts

bun test ./src --timeout 60000          # Ran ~310 tests across ~63 files — check tail output (now includes new request-lifecycle suites)
bun test ./test --timeout 60000         # openapi internal + request-lifecycle-contract (fake upstream; no provider creds) + api-fixtures
bun test src/providers --timeout 60000  # provider registry + catalog + identity
bun test src/auth --timeout 60000       # drivers + refresher
bun test src/persistence/telemetry --timeout 60000  # aggregate parity + pipeline + retention
bun test --timeout 60000 ./src ./test   # all Bun suites
bun test --coverage                     # Bun native coverage (text + lcov)

cd dashboard && bun run test:ci         # vitest + tsc + vite build
```

Isolated disconnect smoke (real server, fake upstream, no public provider — `test/request-lifecycle-contract.test.ts` covers the same invariant deterministically):

```sh
bun test --timeout 60000 ./test/request-lifecycle-contract.test.ts  # asserts fake-upstream AbortSignal.aborted, no further source read, one release, one telemetry finalize on cancel
```

`bun test test` without `./` matches `dashboard/test` — use `./test` prefix.


## Authoring guidance

- Test **observable contracts**, not plumbing: behavior, boundaries, invariants, precedence, real errors — not source-text defaults. Each test must defend a contract and fail on plausible bug.
- Deterministic, isolated, full-suite-safe; co-move with implementation; import `from "./foo.js"` relative, not `../../../src`.
- `pretest`/`prebuild` hooks run `version:check` automatically (`package.json:8`).

## Reproduce testing

```sh
bun test --timeout 60000 src/proxy/events/assembly.test.ts src/proxy/translate/cross-surface.test.ts src/proxy/events/lifecycle.test.ts --timeout 60000
bun test --timeout 60000 ./test/request-lifecycle-contract.test.ts
bunx tsc --noEmit && bun run version:check
bun test ./src --timeout 60000 && bun test ./test --timeout 60000
bun run scripts/dev/verify.ts
cd dashboard && bun run test
```

Expected (command-driven): `bunx tsc --noEmit` exits 0, `bun run version:check` prints `lockstep verified`, `bun test ./src --timeout 60000` tail reports `Ran X tests across Y files — 0 fail` (check output, do not assert a fixed X), `bun test ./test` tail reports `pass` across `request-lifecycle-contract` + openapi suites (check tail; deterministic fake upstream, no creds), `bun run scripts/dev/verify.ts` prints `All verify checks passed`, `cd dashboard && bun run test` tail reports `Test Files ... Tests ...` (check tail; warnings from `dashboard/node_modules` are vitest internals, not failures).

## 3. Troubleshooting

| Symptom | Cause | Check | Fix |
|---|---|---|---|
| `DATABASE_URL missing/hostname` | `requireDatabaseUrl` fail-fast `runtime.ts:63` `pool.ts:33` must be `postgres://` | `bun run scripts/dev/doctor.ts` → `DATABASE_URL` red `postgres scheme` | Set `DATABASE_URL=postgres://user:pass@host:5432/ohmyomop_router` in `.env` |
| `APP_SECRET placeholder/short` | `PLACEHOLDER_PATTERN` or <32 chars prod `resolveEncryptionPolicy runtime.ts:37` | `doctor.ts` → `APP_SECRET` `change-me` | `openssl rand -base64 32` → `APP_SECRET` + `PROXY_API_KEY` |
| `migration gap/advisory lock` | `migrate.ts` Drizzle journal gap `1..20` or lock `727727` held | `drizzle/pg/meta/_journal.json` + `bun run doctor` reports 20 SQL artifacts | `bunx tsc --noEmit && bun run scripts/dev/verify.ts` re-run; check `SELECT * FROM schema_migrations` |
| `telemetry degraded` | Redis `ping` fail → `NoopCache` `pipeline.ts` | `doctor.ts` → `Redis: skipped/degraded` + `health/overhead` `pipeline degraded true` | `REDIS_URL` optional — degraded local 5k keys fallback is expected; monitor `health/overhead` `pendingRecords/dropped` |
| `No Cursor plan` quota `plan:null windows:[]` | `fetchCursorQuota` 404/no plan `src/providers/quota-fetch/cursor.ts` | `curl -H "Authorization: Bearer $TOKEN" https://api2.cursor.sh/api/usage` + `POST /console/api/accounts/:id/quota/refresh` | Expected for free/no-plan — UI shows `No Cursor plan`, retry after login; verify `bun test src/providers/quota-fetch --timeout 60000` |
| `cursor HTTP 464` | Cursor http2 Connect requires `x-cursor-client-version` | `src/providers/oauth-provider/cursor.ts` `CURSOR_CLIENT_VERSION cli-2026.07.23-e383d2b` for `POST /agent.v1.AgentService/Run` and `CURSOR_MODEL_CLIENT_VERSION cli-2026.02.13-41ac335` for `POST /agent.v1.AgentService/GetUsableModels` + http2 `node:http2` `gunzipSync` Connect unary (5-byte flag+length) fallback | Handled as `unsupported` — not empty windows; retry via `fetch` fallback |
| `devin devin-session-token$ missing` | `normalizeDevinSessionToken` prefix required `src/providers/oauth-provider/devin/stream.ts:63` | `src/providers/oauth-provider/devin.ts:GetCliModelConfigs` → `POST https://server.codeium.com/exa.api_server_pb.ApiServerService/GetCliModelConfigs` with `Authorization: Bearer devin-session-token$<token>` + `Metadata{ideName:WINDSURF,ideVersion,extensionVersion}` protobuf (`src/providers/oauth-provider/devin/proto-gen/exa/api_server_pb/api_server_pb.ts` + `codeium_common_pb`) + gzip + Connect 5-byte frame | Prepend if missing `devin-session-token$` via `normalizeDevinSessionToken` |
| `stream truncated without [DONE]` | `src/proxy/transport/sse.ts` counts cumulative upstream bytes before parse and enforces separate bounds `src/proxy/transport/sse.ts:STREAM_BOUNDS` line 64KiB / event 64KiB / buffered 512KiB / events 100k (env `OHMYOMOP_ROUTER_MAX_STREAM_LINE_BYTES`/`EVENT`/`BUFFERED`/`EVENTS` clamped; `src/runtime/limits.ts` defaults line 4MiB/event 4MiB/buffered 512KiB/events 100k) | `bun test src/proxy/transport/sse.test.ts --timeout 60000` | Provider sent EOF without terminal — map to `stream_truncated`; not an Oh My Omop - Router bug |
| `desiredSize<=0 backpressure` | `src/proxy/translate/stream.ts` `ReadableStream.desiredSize` gate retains ≤1 pending frame | `bun test src/proxy/translate/surface.test.ts --timeout 60000` | Slow consumer test — `curl -N` must stop pulling when `desiredSize <=0`; cancel propagates to upstream iterator |
| `doctor DB warning vs /health/ready false` | `doctor` is Windows-safe diagnostics (`Bun.spawn` arrays, `node:path`, no Bash); `scripts/dev/verify.ts` injects fallback `postgresql://ohmyomop_router:ohmyomop_router@127.0.0.1:5432/ohmyomop_router` when `DATABASE_URL` absent (warning ok), while `/health/ready` checks real `DATABASE_URL` + migrations | `bun run scripts/dev/doctor.ts` vs `bun run scripts/dev/verify.ts` + `curl -i http://127.0.0.1:12800/health/ready` | For live readiness check `curl /health/ready` not `doctor`; doctor is diagnostics (tolerates DB absent via verify only) |
| `427 / 413 body too large` | `OHMYOMOP_ROUTER_MAX_REQUEST_BODY_BYTES` 10MiB clamp `src/runtime/runtime.ts:132` + `src/runtime/limits.ts` `[64KiB-64MiB]` | `curl -i` `413` + `bun test src/proxy/normalize src/proxy/translate --timeout 60000` | Reduce payload / raise `OHMYOMOP_ROUTER_MAX_REQUEST_BODY_BYTES` within clamp |
| `proxy test status/body` | `src/console/services/proxy-pool.ts` `test`/`testOne` via `buildProxyFetcher` → `https://api.ipify.org/?format=json` | `POST /console/api/proxies/test` → 200 `{ok:true,latencyMs,egressIp}` or 502 `{ok:false,latencyMs,error}` ; `POST /console/api/proxies/:id/test` → 200 `{ok:true,latencyMs,proxyId,egressIp}` or 502 `{ok:false,latencyMs,proxyId,error}` or 404 | Check `host`+valid `port` required; verify egress `ip` parsing; WireGuard tunnels update `runtime_status` `egress_ip` |
| `model_not_found / capability_unsupported` | `providerAccessFor` + `adapterFor` `src/providers/registry.ts` + `protocol/policy.ts` `forcedToolChoice → auto` | `bun test src/providers --timeout 60000` registry 47 definitions (10 oauth +37 api_key, eager registry size 46 via `src/providers/default-registry.ts` 41 +5 lazy) | Check `GET /v1/models` + `console/api/providers`, verify `builtinProviderDefinitions()` |

## Reproduce troubleshooting

```sh
bunx tsc --noEmit && bun run version:check
bun test ./src --timeout 60000
bun test src/proxy/transport --timeout 60000
bun test src/providers --timeout 60000
bun run scripts/dev/verify.ts
curl -i http://127.0.0.1:12800/health/ready
curl -sS http://127.0.0.1:12800/health/overhead -H "x-api-key: $PROXY_API_KEY" | jq .
```

---
_Merged from SECURITY.md + TESTING.md + TROUBLESHOOTING.md_
