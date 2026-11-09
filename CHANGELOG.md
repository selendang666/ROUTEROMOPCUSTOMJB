# Changelog

All notable changes to Oh My Omop - Router are documented here.

## [2.1.0-beta] - 2026-08-24

### Added

- Perf 99.9 overhead tracking — src/runtime/overhead.ts up to 64 phases (MAX_PHASES 64, MAX_MARKS_PER_REQUEST 64; ~13 hot phases instrumented: ingress.auth/body_read, router.snapshot/plan/attempt/refresh, compression, upstream.dns/fetch, stream.parse/frame, telemetry.enqueue, providers.discovery …) with rolling p50/p95/p99/p99.9+max (RollingSamples DEFAULT_SAMPLES_PER_PHASE 8192 clamped 128–65536 via OHMYOMOP_ROUTER_OVERHEAD_SAMPLES_PER_PHASE), GET /health/overhead + GET /metrics (Prometheus ohmyomop_router_overhead_* via overheadPrometheus()), GET /console/api/overhead + GET /console/api/metrics console mirrors, plus docs/PERFORMANCE.md and scripts/dev/k6-overhead.ts + scripts/dev/overhead-bench.ts (repeatable /health, /v1/models, /share/:token/data, non-stream/stream harness) and scripts/dev/elysia-aot-bench.ts.
- WireGuard pool retained — scripts/warp-generate.ts (Bun X25519 via @noble/curves, POST /v0a737/reg via lanrat flow, --count 50 --out ./pool, cross-OS, no wg binary) and Go sidecar vendor/wireproxy (vendor/wireproxy + gvisor netstack, wireguard-go, AmneziaWG Jc..H4 via amneziawg-go, single-port socks5://127.0.0.1:11080+N, staggered Up() 100ms + GOMEMLIMIT=800MiB for 50 in ~500 MB), console APIs POST /console/api/wireguard/import, GET /console/api/wireguard/status, POST /console/api/wireguard/validate, POST /console/api/wireguard/warp/create, POST /console/api/wireguard/toggle + dashboard WireGuard import modal, docs/WIREGUARD_POOL.md + vendor/wireproxy/TUNING_1GB.md + aliases warp:generate/warp:pool and bench scripts/dev/wg-pool-bench.ts (50×5 MB → 520 MB PASS <650 MB via TUNING_1GB.md).
- IP tracking live — durable client_ip via x-forwarded-for (TRUST_PROXY gated, fallback x-real-ip), request_events (client_ip, model, total_tokens, status, provider, started_at/finished_at) aggregated by GET /console/api/ips/top?window=60&limit=20 (default 20, clamped limit 5–50 via observability.ts, window 10–3600s, RPM, success/errors, models, tokens via telemetry.getTopIps), plus docs/CACHE_HIT.md / docs/PROXY_POOL.md / docs/AUTH_REFRESH.md split and docs/WIREGUARD_POOL.md indexing, cache drill scripts/dev/k6-cache.ts (stable vs volatile prefix); no standalone dashboard Performance page — overhead is surfaced via GET /console/api/overhead polling and Overview health metrics (including wireguardClientMemoryMb).

### Breaking

- Removed the non-standard QUERY request method. The model catalog and all read-only console endpoints use GET; state changes remain POST, PATCH, or DELETE.
- PostgreSQL migration is the 2.1.0-beta schema (16 files 001_initial → 016_wireguard_port_release, advisory lock 727727, SHA256 checksums, contiguous 1..N gap check) with no SQLite compatibility layer. Export/import data manually when moving stores. WireGuard subsystem is retained (vendor/wireproxy, console APIs /wireguard/*, dashboard WireGuard import modal, persistence wireguard_tunnels + wireguard_pool_settings); only the Docker Go build stage was removed and the image health check moved to /health/ready.

### Changed

- IP ban system is retained — ip_bans table via 007_ip_bans.sql (inet PK, ban_expires_at index), BACKUP_TABLES 19 (includes ip_bans) + TABLE_COLUMNS allowlist, IpBanRepositoryShape + createIpBanRepository/createRateLimitRepository in src/persistence/repositories/security.ts and wired in src/bootstrap/application.ts:24/persistence.ts:53/console-wiring.ts, isBlockedIp SSRF guard in src/upstream/ssrf-guard.ts kept. Tracking supplements bans via request_events (client_ip aggregation) and does not remove the ban tables; credential storage remains encrypted (api_keys.key_encrypted, provider_accounts.credential_encrypted, custom_providers.credential_encrypted, proxies.password_encrypted via resolveEncryptionKey/APP_SECRET SHA256, not plaintext; see src/persistence/crypto.ts and src/persistence/backup.ts TABLE_COLUMNS).
- Simplified README.md — kept banner, added What is Oh My Omop - Router? Why do you need it? intro, creative WireGuard line (50 fresh exits in ~500 MB), slim credits (windtf/wireproxy, lanrat, amneziawg, boringtun), and unstable API warning.
- Optimized hot path for p99.9 — DNS LRU 1024, Socks keepAlive maxSockets 256, AbortSignal.any, byte-oriented SSE (0x0A scan + Uint8Array pending), DONE_FRAME pooling, routePlanCache + parallel snapshots, bulk INSERT ${tx(rows)} with eager flush, bounded hedging 300ms, TRUST_PROXY for x-real-ip fallback.
- Pinned the runtime to Bun 1.4.0, Elysia 2.0.0-beta.6, @types/bun 1.4.0, and TypeScript 5.7.3.
- Consolidated handwritten source ownership without facades, wildcard barrels, or duplicate request/response files: protocol translation is provider-oriented, stream/compression each have one transform owner, upstream is fetch plus translate, router is request/route/account/auth/OAuth, persistence is database plus store, and runtime is runtime plus admission.
- Removed the Docker Go build stage and moved the image health check to /health/ready.
- Kept stream terminology to parse/transform/translate and retained bounded SSE limits of 64 KiB per line/event, 512 KiB buffered, and 100,000 events.
- Wired provider quota refresh end-to-end: the console API dispatches provider quota collection, persists provider_account_quota, and the periodic worker refreshes supported active accounts.
- Hardened native OpenAI-compatible and Anthropic compatibility without SDK dependencies: declarative provider profiles support safe query/header rules, stream-usage policy, structured-output gating, strict tools, selected response metadata, Anthropic beta/user-profile policy, metadata, rich document/file sources, cache TTL, citations, and native request controls.
- Hardened upstream client fidelity and live catalogs: local Oh My Omop - Router version stays local while Antigravity, Claude Code, and Codex requests retain their reference-client identities; Antigravity now uses Hub version discovery/failover and supports new Flash/Claude Thinking wire profiles; Codex and Antigravity catalogs refresh per OAuth account with static fallback; 1M Codex/Flash context windows are admitted before dispatch; one-hour Anthropic cache controls add the required extended-cache beta.

### Verification

- bunx tsc --noEmit (backend + dashboard) — clean.
- bun test src --timeout 60000 and bun test ./test --timeout 60000 — exercised (counts float with suite; overhead/stream included: src/runtime/overhead.test.ts, src/stream/sse.test.ts, src/stream/surface-encode.test.ts etc. — do not pin to 31/6/189).
- dashboard: bun run test and bun run --cwd dashboard build — exercised.
- bun build --target bun src/main.ts and bun run scripts/dev/verify.ts — legacy import grep 0 + tsc + build ok.
- Bench bun run scripts/dev/wg-pool-bench.ts — 50 tuned ~520 MB PASS (<650 MB) vs untuned ~770 MB FAIL per vendor/wireproxy/TUNING_1GB.md (GOMEMLIMIT=800MiB GOGC=50, staggered Up 100ms).

### Update 2026-08-30 — Docs & Code Cutoff (amend, version remains 2.1.0-beta)

> Version stays at `2.1.0-beta` — this is an amend that tidies docs and cuts code sampah, no version bump.

#### Docs — cutoff 17 → 7 files, comprehensive Mermaid

- Merged 13 thin docs into 4 thick + 1 comprehensive:
  - `ARCHITECTURE.md` ← `ARCHITECTURE + ROUTING + TRANSLATION` (ownership, request path, routing order, translation contracts, stream & lifecycle)
  - `OPERATIONS.md` ← `ENVIRONMENT + PERSISTENCE + PERFORMANCE + DEPLOYMENT` (env clamp table, PG/SQLite/D1, overhead, compose/migrations)
  - `PROVIDERS.md` ← `PROVIDERS + AUTH_REFRESH + PROXY_POOL + WIREGUARD_POOL + CACHE_HIT` (registry 47, leases/CAS/quota, SOCKS, warp, stable prefix)
  - `QUALITY.md` ← `SECURITY + TESTING + TROUBLESHOOTING` (SSRF/envelope, hybrid tests, symptom→cause→fix)
  - `COMPREHENSIVE.md` (new, 1574 lines) — single comprehensive with full Mermaid + ASCII + tables per section, end-to-end flow Client→Guard→Provider→Client as primary example
  - `API.md` — added Mermaid sequence + ASCII + bounds table (auth, body 10MiB, SSE 64KiB/512KiB/100k)
  - `README.md` — restored rich 2.1 delivery (banner kept), updated refs to merged docs (`OPERATIONS`, `COMPREHENSIVE`), added Comprehensive entry
  - `docs/README.md` — updated index (5 → 6 entries) + reproduction index to merged anchors
  - Deleted 13 thin docs and `_archive` (per request to delete 9router comparison; no file existed, removed from index)

#### AGENTS.md — full rewrite, no file tagging

- Removed all file-path tagging (counts, `src/providers/registry.ts`, advisory `727727`, `BACKUP_TABLES 19`, `STREAM_BOUNDS`)
- Kept conventions only: project/stack/naming/TS strict/testing/env/identity/provider/persistence/verification
- Added: if convention does not fit, ask user before diverging

#### Dashboard — cutoff thin files

- Merged `dashboard/src/lib/is-record.ts` + `errors.ts` + `clipboard.ts` (3 thin, 21 lines) → `helpers.ts` (isRecord + getErrorMessage + copyToClipboard)
- Updated 9 importers (background, overview, filter-sanitize, api-keys-panel, proxy-requests, quota, settings, share, use-clipboard)
- Deleted 3 thin files (-2 net), kept `cn.ts` separate (20 consumers, canonical shadcn)

#### Src — cutoff ~270+ lines, still rocking (726 tests pass)

- `proxy/normalize/detection`: `candidateForClient` table-driven (`CLIENT_FORMAT_BY_NAME`), removed dead `explicitHeaderCandidate`/`userAgentCandidateFor`
- `proxy/normalize/anthropic`: preserve `reasoning.summary` (concise/detailed) via `normalizeReasoning`; payload quirk wiring + tests
- `proxy/translate/cache`: dedup `isWhitespaceCode`/`scanTrimEnd` → import from `detection`
- `proxy/request/prepare`: dedup `headerSnapshotFromHeaders`/`scanTrim` → import from `detection`
- `proxy/translate/request`: `toDataUrl` helper, `clampPreservedReasoning` dedup (80 lines)
- `proxy/translate/cross-surface`: `normalizeDiagnosticText` dedup
- `proxy/translate/policy`: re-export `createModelCatalog`/`capabilitiesOf`/`categoriesOf`/`modelOf`/`aggregateCapabilities` from `types/provider` (80 lines), table-driven `resolveModelWireSurface`
- `proxy/usage`: dedup `isRecord` → import from `validation`
- `proxy/events/repair`: remove dead `fixMissingToolResponses` wrapper
- `auth/http-client`: `buildInit` dedup for `postForm`/`postJson`
- `providers/api-key`: factory 8 (`alibaba`, `fireworks`, `siliconflow`, `cerebras`, `deepseek`, `mistral`, `nvidia`, `gmi-cloud`) via `createSimpleOpenAIProvider` (-95 lines)
- Verification: `bunx tsc --noEmit` (root + dashboard), `bun test ./src 726 pass`, `dashboard 191 pass`, `version:check` lockstep

## [2.0.0-beta] - 2026-08-08

> Beta line from 2026-08-08 to 2026-08-12 — consolidated: OAuth/quota lifecycle, OpenSSE translation, routing, provider concurrency and dashboard hot paths.

### Added

- Unified translation policy — capability-aware OpenAI, Anthropic and Gemini surface resolution, fallback diagnostics and recovery translation.
- Runtime hot paths — session-state reuse, credential metadata caching, provider in-flight accounting, route-attempt lifecycle and bounded transport timeout/abort.
- Dashboard controls — chart-only Usage breakdown (Top 5/Top 10/All), token/cost modes and pointer-following detail cards.
- Providers Devin (Codeium Cascade protobuf) and Cursor (Agent Connect/HTTP2) with native streaming, plus transport modules, share pages and provider icons.
- Quota workers — central TokenRefreshPool (single-flight) and QuotaRefreshWorker with bounded concurrency and persisted health state.
- Regression coverage — credential/session hot paths, routing lifecycle, transport timeouts and persistence contracts.

### Changed

- Routing and provider selection now share canonical translation contracts across adapters and CLI surfaces.
- Transport and recovery use bounded lifecycle across OpenAI/Anthropic/Gemini.
- Console and dashboard composition consolidated — diagnostic wiring reduced, combo strategy inline, proxy lifecycle under src/application/request.

### Fixed

- Usage hover details follow pointer for Top 5/Top 10/All; token mode handling; SSRF guard IPv4-mapped-IPv6 parsing; LoginLimiter sweep; redactPayload value redaction; concurrent limit races.

### Verification

- bun run test — up to 694 passing across 72 backend files; bunx tsc --noEmit clean; dashboard 195 passing; bun run build native binary ok.

## [1.0.2-alpha] - 2026-07-31

### Added

- Unified model/provider picker (browse the live catalog or type a value manually) replacing raw newline-separated textareas for API key allowed-providers/allowed-models/denied-models, combo model lists, and the alias target field.
- Edit action for aliases in Console -> Combos (previously create/delete only).
- `GET /console/api/health/status`: version, process uptime, and a server-clock timestamp the dashboard uses to render its own system time and uptime instead of trusting the browser's clock.
- Health metrics now break down process memory into JS heap (used/total), native/JIT, external (native bindings), and ArrayBuffer segments, plus CPU core count, PID, and CPU model - shown as live bars on the Overview "Health" card.
- Model Studio (Console -> Model Studio, after Providers): a built-in chat playground for testing any provider, model, or combo live, straight from the console - no API key needed. Sends go through the exact same `dispatchQualifiedRoute` pipeline real `/v1/*` traffic uses (combo/alias resolution, stored-account credential rotation, configured system-prompt injection), so a test here reflects production behavior. Chats are saved as switchable sessions (model, optional manual system prompt, max tokens, full message history) so resuming a session resends the identical prefix - letting provider prompt caching kick in across turns. Responses render as full sanitized Markdown (headings, lists, tables, blockquotes) with a language-labeled, copy-button code block, image attachments (paste or upload, up to 4 per message), and a collapsible "thinking" panel for reasoning output.
- Model Studio's "Think" selector (none/low/medium/high/xhigh/max) is sent as `reasoning_effort`; for Anthropic-compatible providers it now translates into the native `thinking` parameter with a matching token budget.
- Customization tab (Console -> System, after Console Log): a placeholder page for upcoming theme/cosmetic controls.
- Pasting more than one line into a pool's Entries field now creates that many separate proxy pools (auto-named with a shared prefix) instead of one pool with N entries, matching the common case of one proxy per provider account. The standalone Import dialog is removed as redundant.
- Provider proxy modes are renamed for clarity: "Proxy pool" -> **Round Robin** (rotates only the pool's proxies) and "Mixed" -> **Round Robin Mix** (also rotates in a direct, no-proxy attempt). Both modes now advance to the next candidate on retry instead of reusing the same failed proxy.
- Console log lines (for both live proxy traffic and the provider "Test" button, now in one unified format) include the proxy pool used (or `direct`), input/output/cached token counts, called tool names, and a short preview of the user's last message.

### Changed

- System prompt is now a built-in default injected on every request; `OHMYOMOP_ROUTER_SYSTEM_PROMPT` is no longer read from the environment. Override or clear it from Console -> Settings.
- Filter Rules defaults are hardcoded in code (`src/console/default-sanitizer-rules.ts`) and are no longer seeded into SQLite; the `sanitizer_rules` table stores only operator overrides of built-ins and fully custom rules. The console API and route prefix are renamed to `filter.sanitize` for naming consistency with the dashboard's "Filter Rules" label.
- `POST /console/api/combos/resolve-preview` now resolves and reports the actual routed target (provider/model/surface) after alias/combo/filter resolution, instead of stopping at the filter-check step.
- Console sidebar shows the product name, current version (from `package.json`), and a GitHub release-update badge/link instead of static "Internal Console" branding.
- Console footer redesigned into a compact grid (2x2 on mobile, single row on desktop): server-synced UTC and system-local clocks (not the browser's clock), and live uptime.
- List-item entrance animations across Providers, Overview, Combos, Filter Rules, Proxy Pools, and Usage now use CSS keyframes instead of framer-motion `motion.div`, avoiding a known `visualElement` retention issue on navigation.
- Console sidebar no longer shows a scrollbar track while scrolling (still scrollable, just visually hidden).
- Console navigation now animates: page content crossfades with a subtle scale on every route change, and the sidebar's active-item highlight slides between entries instead of cutting in place.
- Real upstream error messages now propagate through every built-in provider adapter, replacing a generic "rejected this request" wrapper wherever a provider call fails.

### Fixed

- Provider detail page (`/console/providers/:id`) crashed with a React error on every visit (state update during render, then a hook-count mismatch from a hook called after a conditional early return).
- Alias edit/delete buttons in Console -> Combos were missing/non-functional; delete previously sent the wrong HTTP method.
- `resolveEffectiveFilterRules()` queried the database twice per call.
- Switching a provider's proxy mode to Round Robin or Round Robin Mix with no pool yet selected no longer fails with a 400; the first available pool is auto-selected.
- Bulk-deleting provider accounts no longer reports the whole batch as failed when only one delete fails; deletes run with bounded concurrency and report an accurate deleted/total count.
- A provider adapter reporting a genuine upstream 5xx no longer gets collapsed to a hardcoded 502.
- A failed read of an error response body no longer masks the real HTTP status of that response.

## [1.0.1-alpha] - 2026-07-30

### Changed

- Provider credentials are stored as plaintext in `provider_accounts.credential` and `custom_providers.credential`; only the console login password remains hashed. Credential-at-rest encryption, the `CREDENTIAL_ENCRYPTION_KEY`/`CREDENTIAL_ENCRYPTION_KEY_FILE` settings, the on-disk credential key file, and the "Rotate credential key" console action are removed.
- Proxy API keys are now stored as plaintext in `api_keys.key`. The full key can be retrieved via `GET /console/api/keys/:id/credential` and copied from the dashboard.
- Removed the `OPENCODE_FREE_ACCESS` env setting and the `opencodeFreeAccess` runtime setting entirely. OpenCode Free models are always accessible to any request with a valid Oh My Omop - Router API key, exactly like every other provider namespace.
- Internal cleanup pass (no behavior change): consolidated duplicated numeric validation, text flattening, model-id extraction, date/period arithmetic, console SSE streaming, closed-set type guards, and upstream provider HTTP-error/finish-reason mapping into shared modules (`src/utils/`, `src/shared/`, `src/console/sse.ts`, `providers/index.ts`'s `classifyUpstreamStatus`/`providerHttpError`). See `.kiro/specs/codebase-merge-optimization/` for the full audit and rationale, including proposals intentionally rejected (dynamic error-class migration, generic delete-record helper).

### Fixed

- Hardened every user-configured upstream and proxy URL against private IPv4/IPv6 targets, DNS rebinding, and unsafe redirect chains. Custom-provider dispatch now validates resolved targets immediately before network I/O.
- Stored provider-account authentication failures now fail over to the next eligible account; repeated account/model failures are isolated with per-model locks instead of taking down the entire account.
- Interrupted streaming responses now emit protocol-correct terminal error events, terminal sentinels, and cancel their upstream reader when the client disconnects.

- Testing a provider connection no longer fails with a generic 500 "Something unexpected interrupted this request" error. Credential reads previously threw an unguarded decryption error whenever the stored key no longer matched the running server's key (for example after a redeploy that reset the key file), which broke both the console's Test action and live account-rotated proxy traffic.

### Added

- ACL-aware `GET /v1/models`: when `PROXY_AUTH_MODE=api_key`, a valid proxy key is required; the response includes only models permitted by that key's provider/model allowlists and denylist (aliases and combos included). In open mode the catalog is public, but an optional key still filters the list.
- Extended proxy API key limits and ACL: monthly token cap, max concurrent in-flight requests, model denylist, and `PATCH /console/api/keys/:id` for editing limits after creation.
- Overview dashboard **Edit** action for API keys (limits, provider allowlist, model allow/deny lists).

- `GET /v1/models` now advertises all locally routeable built-in provider models, custom-provider models, aliases, and combos using the same IDs accepted by dispatch.
- Versioned SQLite migrations, persisted account cooldown/model-lock state, periodic WAL checkpoints, and graceful DB shutdown.
- Opt-in `CORS_ALLOWED_ORIGINS` support for public `/v1/*` APIs only.
- Bulk provider-account import from pasted exports, with worker parsing, duplicate-name handling, line-level reporting, and an Import dialog in provider detail.
- Cursor-paginated provider connections with incremental/windowed dashboard rendering for large account collections.
- Bounded runtime rate-limit and request-detail tracking, scheduled memory cleanup, and a documented local memory smoke test.

- Copy action on each provider connection, backed by `GET /console/api/providers/:id/accounts/:accountId/credential`. The secret is fetched only when the operator clicks copy (never in the polled accounts list) and the read is audited.

### Removed

- `POST /console/api/settings/rotate-credential-key` and the credential-key rotation UI.
- The settings Danger Zone section, its "Rotate JWT secret" button, and the "Log out all sessions" button. The `/console/api/settings/rotate-jwt-secret` and `/console/api/settings/logout-all` endpoints remain available.

### Migration

- The `credential_enc` columns are renamed to `credential`. Existing databases carry unreadable ciphertext under the old key, so reset the database (delete `DATA_DIR/ohmyomop-router.sqlite*` and `DATA_DIR/.credential-key`) and re-add provider connections.
- Migration v7 adds `monthly_token_limit`, `max_concurrent_requests`, and `model_denylist` to `api_keys`. Existing databases upgrade automatically on startup.

### Verification

- Backend test suite: 464 tests passing, 1 skipped.
- Dashboard TypeScript typecheck and production build passing.

## [1.0.0-alpha] - 2026-07-30

This is the first release-line marker for the feature-complete alpha. It is intended for local and self-hosted testing while upstream provider behavior and operational hardening continue to mature.

### Added

- Authenticated React/Vite management console with responsive desktop and mobile layouts.
- OpenAI Chat Completions, OpenAI Responses, and Anthropic Messages compatibility routes.
- Built-in provider catalog with OAuth, API-key, free-tier, and compatible-provider integrations.
- Console-managed custom OpenAI-compatible and Anthropic-compatible providers.
- Custom provider headers, model metadata enrichment, per-model testing, and direct `<slug>/<model>` model qualification.
- Aliases, combos, filter rules, account routing, failover, cooldowns, priority routing, and round-robin routing.
- Runtime usage, estimated cost, in-flight request, per-IP active-flight, health, CPU, and memory metrics.
- Cross-platform RAM clearing through Bun garbage collection.
- Provider credential storage, API-key access control, console JWT sessions, and schema migration support.
- Responsive themed dropdowns and compact mobile app-bar navigation.
- Route-chunk prefetching and direct route rendering to keep console navigation responsive.

### Changed

- Provider ordering is curated manually instead of alphabetically.
- Custom provider model IDs no longer use a public `custom/` wrapper.
- Health metrics distinguish whole-machine RAM from Oh My Omop - Router process RSS and display explicit MB/GB units.
- Unicode punctuation in user-facing dashboard text is rendered as actual punctuation instead of literal `\\uXXXX` sequences.
- Global error logging now records the underlying server error for unhandled 500 responses.

### Verification

- Backend test suite: 417 tests passing.
- Dashboard TypeScript typecheck and production build passing.
- Browser smoke tests cover provider management, custom provider routing, health metrics, themed dropdowns, mobile layout, and repeated console navigation.

### Alpha caveats

- Provider availability, quotas, authentication flows, and model catalogs remain dependent on upstream services.
- Upstream provider-specific regressions may require adapter updates as their APIs change.
