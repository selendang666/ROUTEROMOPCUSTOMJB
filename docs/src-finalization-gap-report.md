# Oh My Omop - Router `src/` Finalization Gap Report

**Scope:** `src/` architecture, runtime flows, provider/catalog boundaries, persistence and telemetry, console/API surfaces, security, test coverage, and legacy cleanup.

**Repository footprint observed:** 408 files under `src/`, including 405 TypeScript files and 103 `*.test.ts` files. The audit used parallel read-only reviews covering runtime/bootstrap, proxy execution, providers/catalogs, persistence/telemetry, console/observability, security, and test/legacy coverage.

## 1. Executive Summary

Oh My Omop - Router has a coherent intended architecture, but several refactors were layered on top of copied legacy paths instead of completing a clean cutover. The result is a system that is functionally broad but fragile at the seams:

- multiple authorities exist for limits, route snapshots, provider catalogs, telemetry schemas, and retry/commit behavior;
- production wiring does not consistently connect contracts that exist in code;
- security controls are present in isolated modules but are bypassed or weakened at composition boundaries;
- SQLite/D1 telemetry is the runtime authority while PostgreSQL contains a parallel, mostly vestigial telemetry schema;
- lifecycle logging is now richer, but stream-terminal classification, request-events parity, and old-row handling still need a final contract;
- manual/BYOK provider identity was previously allowed to cross the builtin catalog boundary, producing UUIDs in Free Limited; that specific leak is now closed, but namespace, routing, and deletion integrity still need hardening;
- test coverage is good at leaf utilities and weak at bootstrap/composition/integration boundaries.

The most important conclusion is that the codebase should not receive more feature patches until the composition boundaries are made explicit. The recommended final state is a small number of canonical services and contracts:

1. one runtime configuration/limits authority;
2. one route snapshot/catalog authority;
3. one request execution/retry/commit path;
4. one provider identity model with disjoint builtin/custom namespaces;
5. one telemetry row codec and one telemetry authority per deployment;
6. one authenticated console mutation boundary with CSRF and rate limiting;
7. one lifecycle event model shared by `/v1`, probe, and SSE presentation.

## 2. Current Architecture — Before Finalization

### 2.1 High-level flow

```text
HTTP /v1/*
   │
   ├─ header snapshot / auth / body limits
   │      src/api/v1.ts
   │      src/api/guard.ts
   │
   ├─ normalize request and surface
   │      src/proxy/protocol-request.ts
   │      src/proxy/translate/cross-surface.ts
   │
   ├─ build route snapshot and route plan
   │      src/bootstrap/proxy-port.ts          (inline snapshot builder)
   │      src/persistence/repositories/accounts.ts (DB snapshot cache)
   │      src/proxy/routing/plan.ts             (second pure snapshot/cache path)
   │
   ├─ prepare and compress request
   │      src/proxy/request/prepare.ts
   │      src/compression/*
   │
   ├─ attempt / lease / network / provider call
   │      src/proxy/request/attempt.ts
   │      src/proxy/routing/account.ts
   │      src/proxy/transport/network.ts
   │      src/proxy/upstream/*
   │
   ├─ translate and commit response
   │      src/proxy/translate/*
   │      src/proxy/events/commit.ts
   │      src/proxy/translate/stream.ts
   │
   └─ telemetry / console logs
          src/persistence/telemetry/pipeline.ts
          SQLite or D1 at runtime
          PostgreSQL telemetry tables also exist but are not written by the pipeline
```

### 2.2 Console/probe flow

```text
Console browser
   │
   ├─ /console/api/providers
   ├─ /console/api/probe
   ├─ /console/api/logs/stream
   └─ /console/api/settings

Console route guard
   │
   ├─ ban guard
   ├─ rate-limit guard
   └─ session guard

Probe
   │
   ├─ resolves credential directly
   ├─ creates its own NetworkSelector
   ├─ calls adapter directly
   ├─ writes request_events telemetry
   └─ writes console_logs lifecycle entries

Console logs SSE
   │
   ├─ initial queryLogs snapshot
   ├─ one-second polling afterId cursor
   ├─ ping heartbeat
   └─ read-time IP masking
```

### 2.3 Provider/catalog flow

```text
Builtin definitions ───────┐
                            ├─ ProviderRegistry ── routing
provider_models table ─────┤
                            ├─ console provider detail
custom_providers table ────┘
       │
       └─ custom adapter registered with metadata.id = custom slug

/console/api/providers
   └─ listBuiltins() + list()

Dashboard
   ├─ useProviders()
   ├─ builtin/free/OAuth/API-key sections
   └─ Custom Providers section
```

The original BYOK leak happened because the combined API response was consumed as if every item were a builtin summary. Custom entries had `slug`/`models` but no `credentialKind`, so the dashboard normalized them as `authKind: "none"` and placed them in Free Limited.

That specific issue has been corrected in the working tree by:

- marking builtin/custom response entries explicitly;
- filtering custom adapters out of `listBuiltins()`;
- defensively filtering custom-shaped entries in the dashboard provider hook;
- preventing the API-key section from classifying no-auth entries as API-key providers.

Those changes solve the observed UUID presentation leak, but they do not yet solve the deeper provider namespace and routing-integrity gaps below.

## 3. Gap Classification

Severity meanings:

- **P0 / Critical:** production security or quota bypass; fix before horizontal deployment or public exposure.
- **P1 / High:** correctness/data-integrity/composition issue that can produce wrong routing, wrong telemetry, or unrecoverable state.
- **P2 / Medium:** operational fragility, drift, or maintenance hazard with bounded impact.
- **P3 / Low:** cleanup, naming, test quality, or future hardening.

## 4. P0/P1 Gaps — Must Close Before Finalization

### G-01 — API-key admission is not wired into the production `/v1` path

**Severity:** P0 / Critical

**Evidence:**

- `src/proxy/request/execute.ts:153-157` acquires admission only when `dependencies.admission !== undefined`.
- `src/bootstrap/proxy-port.ts:~180-300` builds route dependencies but does not pass a production `ApiKeyAdmission` instance.
- `src/runtime/key.ts:64-154` contains the in-memory admission implementation.

**Current behavior:**

The executor treats admission as optional. Tests can inject it, but the production proxy port appears to omit it. If confirmed in the composition path, configured API-key RPM, daily/monthly/one-time token, and `maxConcurrentRequests` limits are not enforced for live `/v1` requests.

**Why the gap exists:**

Admission was introduced as an injectable runtime service, but the bootstrap composition retained an older route-dependency construction and did not make admission a required production dependency.

**After-state proposal:**

```text
Production executor dependencies
├─ admission: required
├─ route snapshot: required
├─ telemetry: required or explicit no-op port
└─ coordination: explicit local/shared mode
```

Make `admission` required in the production dependency contract. If single-process memory admission is intentional, make that an explicit deployment invariant. If replicas are supported, back rate/concurrency/token reservations with atomic coordination; the existing Redis coordination API is not currently consumed by `ApiKeyAdmission`.

**Acceptance:**

- live `/v1` request with a one-time token limit consumes the reservation;
- concurrent requests cannot exceed `maxConcurrentRequests`;
- daily/monthly/RPM limits are enforced;
- multi-replica behavior is either atomic or explicitly rejected/documented as single-process-only;
- no `dependencies.admission === undefined` production path remains.

### G-02 — API-key provider/model ACL fields are dropped before route selection

**Severity:** P0 / Critical

**Evidence:**

- `src/api/v1.ts:189-199` passes only `apiKeyId` to the proxy handle.
- `src/bootstrap/proxy-port.ts:~286-300` builds executor authorization with `apiKeyId` and `trustedIdentity`, but no provider/model allowlist or denylist.
- `src/proxy/request/execute.ts:163-166` calls `isRouteAllowed(...)` using the incomplete authorization object.
- `src/console/services/api-keys.ts:193-220` exposes API-key records with scope fields.

**Current behavior:**

Provider/model ACL configuration can exist in the database and console API, but the live `/v1` path does not appear to carry those fields into `executeProxyRequest`. Route filtering therefore sees undefined ACL fields and may allow every provider/model.

**Why the gap exists:**

The authorization record was narrowed at the ingress-to-proxy adapter boundary, likely during the executor cutover. The executor correctly calls an ACL function, but composition passes an incomplete authorization shape.

**After-state proposal:**

Resolve the complete immutable authorization snapshot once after API-key authentication and pass it through the typed proxy request boundary:

```text
authenticateApiKey
   └─ ApiKeyAuthorizationSnapshot
        ├─ apiKeyId
        ├─ providerAllowlist
        ├─ modelAllowlist
        ├─ modelDenylist
        ├─ limits
        └─ admission identity
```

Do not reconstruct or re-query scopes inside provider adapters. Make `ProxyAuthorization` required for `/v1` and add a compile-time contract test that a denied provider/model cannot reach `adapter.call`.

**Acceptance:**

- denied provider returns a typed authorization failure before provider dispatch;
- denied model returns a typed authorization failure before route lease;
- allowlist and denylist precedence is deterministic and documented;
- tests prove the provider adapter is never called for denied targets.

### G-03 — Stream terminal events incorrectly classify failures as complete

**Severity:** P1 / High

**Evidence:**

- `src/proxy/request/execute.ts:421-479` stream generator `finally` unconditionally emits `event: "complete"`.
- The same block forwards `streamErrorKind` to telemetry while the console event remains complete.
- `src/proxy/events/commit.ts:13-48` defines commit semantics, but the stream wrapper does not use them to classify terminal lifecycle events.
- `src/proxy/request/attempt.ts:84-133` owns a separate stream-release wrapper.

**Current behavior:**

A stream that terminates with provider error, timeout, or client abort can produce an informational complete log. Telemetry may contain an error while Console Logs show a successful-looking completion.

**Why the gap exists:**

Streaming was treated as a successful handoff after `adapter.call()` returned. Terminal errors occur later during iteration, outside the outer retry/catch boundary.

**After-state proposal:**

Make the stream generator own a typed terminal state:

```text
stream starts
   │
   ├─ committed = false
   ├─ events mark semantic commit
   ├─ normal message_stop → complete
   ├─ client signal/abort → aborted
   └─ provider/transport error → failed
```

Use one commit gate from `src/proxy/events/commit.ts`. Emit the terminal console event and telemetry fact from the same terminal-state object. Do not infer `complete` merely from entering `finally`.

**Acceptance:**

- normal stream: incoming → complete;
- client disconnect: incoming → aborted with status 499 in presentation and status 0/error null in request-events policy;
- provider stream error: incoming → failed;
- no stream error is rendered as info/complete;
- lease and in-flight counters release exactly once.

### G-04 — No-retry-after-semantic-commit is defined but not enforced

**Severity:** P1 / High

**Evidence:**

- `src/proxy/events/commit.ts:13-48` defines `isCommitEvent`, `createCommitGate`, and retry-after-commit logic.
- `src/proxy/request/execute.ts:271-290` retry decision does not consult the commit gate.
- `src/proxy/request/attempt.ts:84-133` uses a separate stream wrapper without commit tracking.

**Current behavior:**

The invariant exists in a module but is not wired into the live executor. A future change to retry stream errors can rotate accounts after the client has already received semantic output.

**After-state proposal:**

Thread a single commit gate through `RouteAttemptContext`. Every yielded stream event marks the gate. `shouldRetry` must return false once committed. Keep `commit.ts` as the sole owner of commit-event classification and delete the duplicate wrapper after migration.

**Acceptance:**

- tool call start/delta and text output mark committed;
- post-commit provider failure never starts another candidate;
- pre-commit transport failure may retry if policy allows;
- tests cover duplicate tool-call and client-abort boundaries.

### G-05 — Probe accepts an account ID without proving provider ownership

**Severity:** P0 / Critical

**Evidence:**

- `src/console/services/probe.ts:74-97` accepts `body.accountId`.
- It calls `getAccountCredential(accountId)` without checking that the account belongs to the requested `provider`.
- `src/console/services/probe.ts:108-123` resolves the requested provider independently.

**Current behavior:**

An authenticated console caller can provide an account ID belonging to provider A while requesting provider B. The credential can then be passed to provider B.

**Why the gap exists:**

The probe path predated the shared account-selection boundary and treats account lookup as a credential lookup rather than a provider-scoped selection.

**After-state proposal:**

Resolve account metadata and credential together through a provider-scoped port:

```text
selectProbeAccount(providerId, requestedAccountId?)
   ├─ account exists
   ├─ account.provider === providerId
   ├─ active/healthy eligibility
   └─ decrypt credential
```

Never allow a raw account ID to bypass provider ownership validation.

**Acceptance:**

- mismatched account/provider returns a typed 400/404 without decrypting or calling the adapter;
- explicit account and auto-selected account use the same eligibility path;
- focused negative test proves no credential reaches the wrong provider.

### G-06 — Trust boundary accepts spoofed `x-real-ip` when `TRUST_PROXY` is false

**Severity:** P0 / Critical

**Evidence:**

- `src/api/guard.ts:158-180` `clientIpOf` uses `x-real-ip` even when forwarded proxy trust is disabled.
- `src/api/guard.ts:181-193` `clientIpForBan` also accepts `x-real-ip`.
- The value feeds public admission/ban/rate-limit decisions.
- Existing tests cover ignored X-Forwarded-For but codify the x-real-ip behavior.

**Current behavior:**

A direct client can send arbitrary `x-real-ip` values to rotate rate-limit and ban identities and poison telemetry identity.

**After-state proposal:**

Use the TCP peer address unless the request comes through an explicitly trusted proxy boundary. If `TRUST_PROXY=false`, ignore both forwarded headers. If `TRUST_PROXY=true`, define trusted proxy count/allowlist and normalize IP literals before use.

**Acceptance:**

- direct requests cannot choose their identity with `x-real-ip`;
- trusted ingress can supply normalized forwarded identity;
- ban, rate-limit, and telemetry use the same resolved client identity;
- spoofing tests cover XFF, x-real-ip, IPv6, port suffixes, and malformed values.

### G-07 — SSRF DNS validation remains time-of-check/time-of-use

**Severity:** P1 / High

**Evidence:**

- `src/proxy/transport/network.ts:143-183` validates resolved addresses at dispatch.
- `src/proxy/transport/fetch.ts:24-40` later invokes global fetch, which resolves the hostname independently.

**Current behavior:**

A hostname can resolve to a public address during validation and a private address during the actual connection.

**After-state proposal:**

Pin the validated address into the outbound connection or revalidate the actual socket destination. Keep redirect validation and add an outbound dispatcher/connector abstraction that owns DNS resolution and connection selection.

**Acceptance:**

- public hostname resolving to private address is rejected;
- DNS changes between validation and connect cannot reach private networks;
- redirects are validated at every hop;
- custom providers and OAuth endpoints use the same transport policy.

### G-08 — Console session token is returned in JSON despite HttpOnly cookie

**Severity:** P1 / High

**Evidence:**

- `src/console/routes/auth.ts:8-22` and `:40-41` set a cookie and return `result.data`.
- `src/console/services/auth.ts:64-68` and `:147-151` create the token.

**Current behavior:**

A same-origin script, reflected XSS, analytics integration, or browser extension can read the JSON token even though the cookie is HttpOnly.

**After-state proposal:**

Return only non-secret session metadata. Rely on the HttpOnly cookie for browser sessions. If a token flow is intentionally supported, make it an explicit separate endpoint with a separate threat model and scope.

**Acceptance:**

- login/setup response body contains no bearer-equivalent session token;
- cookie session remains functional;
- tests assert no secret token appears in JSON or logs.

### G-09 — Console cookie security and CSRF boundary are incomplete

**Severity:** P1 / High

**Evidence:**

- `src/console/routes/auth.ts:16` and `:40` hard-code `HttpOnly; SameSite=Lax; Max-Age=604800` without `Secure`.
- `src/api/guard.ts:467-483` has a separate cookie helper with HTTPS-aware behavior.
- `src/console/api.ts:36-44` applies session guard but no explicit CSRF boundary is identified.

**Current behavior:**

Cookie construction is duplicated and inconsistent. State-changing cookie-authenticated console requests lack an explicit Origin/CSRF policy.

**After-state proposal:**

Use one cookie builder. Add CSRF protection for mutating console requests, preferably an Origin/Referer policy plus a double-submit token if cross-origin legitimate clients are required. Apply rate limiting before session verification for login/setup abuse.

**Acceptance:**

- HTTPS session cookie includes Secure under the deployment’s actual proxy semantics;
- malformed/missing Origin behavior is explicit;
- cross-site POST/PATCH/DELETE cannot mutate console state;
- unauthenticated login attempts are rate-limited independently of authenticated session limits.

### G-10 — Public share guard fails open during dependency outage

**Severity:** P1 / High

**Evidence:**

- `src/bootstrap/application.ts:90-105` catches `ipBanRepo.isBanned` failures as false.
- It catches rate-limit failures as count zero and continues.

**Current behavior:**

A database/rate-limit outage can bypass share-route bans and rate limits, allowing public work to continue without the intended controls.

**After-state proposal:**

Fail closed with bounded 503/429 behavior or use an explicitly documented local fallback. Do not convert security dependency failure into an allow decision silently.

**Acceptance:**

- outage tests prove share access is bounded;
- error response is stable and observable;
- `/v1`, `/share`, and console routes document their fail-open/fail-closed policy consistently.

### G-11 — Upstream provider error code is not bounded before public serialization

**Severity:** P1 / High

**Evidence:**

- `src/proxy/transport/errors.ts:95-130,220-249` copies upstream `error.code`.
- `src/proxy/events/commit.ts:201-206` emits the provider code publicly.

**Current behavior:**

A hostile upstream can inject a very large or sensitive arbitrary provider code into response/telemetry paths.

**After-state proposal:**

Validate provider codes as short safe tokens. Bound length and character set; omit unknown values or map them to a stable internal code. Preserve raw upstream detail only in bounded, access-controlled diagnostic storage if required.

**Acceptance:**

- public provider code has a strict maximum length and safe character set;
- sensitive/newline payloads never cross the client response boundary;
- telemetry and response serialization share the same bounded field.

## 5. P1/P2 Architecture and Correctness Gaps

### G-12 — Runtime limits have two authorities

**Evidence:**

- `src/runtime/runtime.ts:123-168` builds injected `RuntimeConfig.limits`.
- `src/runtime/limits.ts:6-27` builds import-time `runtimeMemoryLimits`.
- `src/bootstrap/proxy-port.ts:102-103`, `src/runtime/key.ts:35-38`, and `src/proxy/transport/sse.ts:21-25` use the global table.
- `src/api/guard.ts:6-18` also re-reads environment-derived body limits.

**Gap:** tests/configuration can claim one limit while hot paths enforce another. Import-time caches also make test isolation and runtime diagnostics unreliable.

**Proposal:** make `RuntimeConfig.limits` canonical; inject it through ports or expose one frozen runtime accessor. Delete duplicated parsing after migration. Add effective-limit diagnostics.

### G-13 — Three competing route snapshot builders

**Evidence:**

- `src/persistence/repositories/accounts.ts:36-107` owns a DB-backed snapshot/cache.
- `src/proxy/routing/plan.ts:28-120,407-483` has a separate pure snapshot/cache path.
- `src/bootstrap/proxy-port.ts:189-300` reconstructs a third snapshot inline for every request.

**Gap:** provider prefixes, model capabilities, proxies, accounts, and invalidation semantics can differ by caller. Custom provider mutations do not fully invalidate/re-register runtime adapters.

**Proposal:** define one `RouteSnapshot` loader and one cache. `proxy-port.ts` should consume it instead of rebuilding 300 lines of routing state. Provider/custom mutations must invalidate the snapshot and refresh registry adapters synchronously or via an explicit generation barrier.

### G-14 — Provider catalog has three divergent truths

**Evidence:**

- static adapter catalogs under `src/providers/api-key/*`;
- persisted `provider_models` in `src/persistence/schema/pg.ts:189`;
- `custom_providers.models_json` in `src/persistence/schema/pg.ts:247` and `src/providers/api-key/custom-provider.ts:58-106`;
- `src/bootstrap/proxy-port.ts:191-194` builds route models from registry models and ignores `provider_models.enabled`.

**Gap:** a model disabled in the console can remain routable; discovered models and custom models do not share one source; detail and routing can disagree.

**Proposal:** create a `ProviderCatalogService` returning one `ModelView` contract. Persisted enabled/metadata fields override static defaults. Use the same service for provider detail, dashboard list, route planning, and adapter model lookup. Migrate custom models into the unified catalog or explicitly mark `models_json` as a cache with a single owner.

### G-15 — Builtin/custom provider IDs share one namespace and collisions fail silently

**Evidence:**

- `src/providers/registry.ts:16` keys adapters by `metadata.id` and throws on duplicate registration.
- `src/providers/api-key/custom-provider.ts:287-291` silently skips a custom slug colliding with a non-custom adapter.
- `src/console/services/providers.ts:373-421` accepts arbitrary slugs and defaults missing slug to a UUID.
- `src/persistence/schema/pg.ts:247` makes custom slug unique but does not reserve builtin IDs.

**Gap:** a custom provider can be persisted successfully but not routable, while the console detail route may still return the DB row. Case-sensitive registry IDs and case-insensitive service lookup also disagree.

**Proposal:** reserve builtin IDs case-insensitively at create time and return 409 `slug_reserved`. Normalize identity comparison. Convert silent adapter skip into explicit startup/create diagnostics. Keep internal UUIDs, but use a disjoint external custom namespace.

### G-16 — BYOK account rows can be orphaned and remain routable

**Evidence:**

- `src/console/services/providers.ts:416-421` creates `provider_accounts` rows for custom slugs.
- `src/console/services/providers.ts:469-471` deletes only `custom_providers`.
- `src/persistence/schema/pg.ts:51` has free-text `provider` with no FK to custom provider slug.
- `src/persistence/repositories/accounts.ts:107` loads active accounts without proving custom-provider liveness.

**Gap:** deleting a custom provider leaves active account rows. Route snapshots can attempt to lease credentials for a dead provider.

**Proposal:** make custom provider creation/account creation/removal transactional. Delete or soft-disable dependent accounts atomically. Add an integrity sweep migration for existing orphans. Enforce slug immutability and provider ownership.

### G-17 — Custom provider mutations do not fully update runtime routing

**Evidence:**

- `src/bootstrap/proxy-port.ts:65` calls `syncCustomAdapters` at port creation.
- `src/console/services/providers.ts:430-467` updates custom DB rows without the route mutation callback.
- `src/providers/api-key/custom-provider.ts:287-306` reconciles custom adapters only when explicitly called.

**Gap:** create/update/remove may require a process restart or stale snapshot expiry before routing reflects the change.

**Proposal:** wire provider mutations into the same route mutation coordinator used by accounts/models/proxies. Reconcile custom adapters, invalidate route snapshots, and publish a revision in one operation.

### G-18 — Legacy provider aliases are not normalized at one boundary

**Evidence:**

- canonical definitions in `src/providers/registry.ts:104-186`;
- legacy values such as `claude-code`, `zai-coding-plan`, and `github-copilot` remain possible in free-text account/provider fields;
- quota fetchers and routing prefixes use exact IDs in `src/providers/quota-fetch/fetch.ts` and `src/proxy/routing/plan.ts`.

**Gap:** old rows can be healthy but unroutable, quota lookups can miss, and dashboard grouping can classify them incorrectly.

**Proposal:** add one provider alias registry and normalize at ingress/read/write boundaries. Migrate legacy rows in a reversible migration. Remove aliases only after telemetry/config references are migrated.

### G-19 — Custom-provider extensibility columns are dead at runtime

**Evidence:**

- `src/persistence/schema/pg.ts:247` defines `surfaces_json`, `endpoints_json`, `quirks_json`, `native_passthrough`, and `compact_path`.
- `src/bootstrap/proxy-port.ts:26-60` does not select them.
- `src/providers/api-key/custom-provider.ts:101-113` does not consume them.

**Gap:** schema promises capabilities that routing does not implement. Operators cannot tell whether a stored setting is active.

**Proposal:** either wire and validate them end-to-end or remove them in a planned migration. Do not leave columns that imply functionality. If retained, emit a startup warning when populated but unsupported.

### G-20 — Duplicate retry/stream/compression/snapshot implementations

**Evidence:**

- canonical retry path in `src/proxy/events/commit.ts:102-140`;
- legacy `src/proxy/request/resilience.ts:18-54` remains and is used by tests;
- duplicate stream ownership in `src/proxy/events/commit.ts` and `src/proxy/request/attempt.ts:84-133`;
- live compression in `src/proxy/request/prepare.ts:99-111`, legacy `src/proxy/request/compression-pipeline.ts` remains;
- snapshot duplication in `src/proxy/routing/plan.ts` and `src/bootstrap/proxy-port.ts`.

**Gap:** future contributors can import the wrong implementation, and tests can validate a path production does not use.

**Proposal:** complete the cutover and delete weightless legacy modules. Keep only one retry executor, one commit gate, one stream-release owner, one compression pipeline, and one route snapshot builder.

## 6. Persistence and Telemetry Gaps

### G-21 — PostgreSQL telemetry schema is a parallel, mostly idle authority

**Evidence:**

- PG `request_events`/`console_logs` definitions in `src/persistence/schema/pg.ts:384-466`;
- runtime store selection in `src/persistence/telemetry/pipeline.ts:92-98` selects SQLite or D1;
- SQLite/D1 writers are under `src/persistence/telemetry/store/*`;
- backup/restore in `src/persistence/backup.ts:145-164,312-380` treats telemetry separately.

**Gap:** operators see PG telemetry tables but the runtime does not write them. Backup/restore uses different semantics and restore re-enqueues through a volatile ring.

**Proposal:** explicitly declare SQLite/D1 as telemetry authority. Mark PG mirror deprecated, or implement a deliberate dual-write contract with tests. Add native telemetry dump/import instead of paginated re-enqueue for restore. Do not drop PG tables until existing deployments are inventoried.

### G-22 — Telemetry row/schema mapping is duplicated in SQLite and D1

**Evidence:**

- `src/persistence/telemetry/store/sqlite/writer.ts:52-130`;
- `src/persistence/telemetry/store/d1/writer.ts:35-102`;
- duplicate `toRow`, mapping, context parsing, filter/pagination logic;
- `src/persistence/telemetry/store/interface.ts:31-79` is the only shared shape.

**Gap:** every new column requires synchronized edits. A missing D1 field can silently return NULL while mocked parity tests still pass.

**Proposal:** extract a shared row codec with canonical column order, context parser, filter semantics, and row mapping. Keep SQLite/D1 adapters limited to execution/storage details. Add schema parity tests against migration SQL and PG schema.

### G-23 — Telemetry queues are volatile and can lose data on crash

**Evidence:**

- `src/persistence/telemetry/pipeline.ts:110-143` uses in-memory ring buffers and arrays;
- `src/persistence/telemetry/buffer/ring.ts:14-64` is process-memory only;
- `src/persistence/telemetry/pipeline.ts:360-385` shutdown is best-effort;
- overflow/drop counters do not create durable recovery.

**Gap:** crash/power loss between enqueue and flush loses request events, logs, and payloads. D1 outage after shutdown retries can leave process-memory data behind.

**Proposal:** add an optional durable spool backed by SQLite when available. Keep memory fast path, but persist unacknowledged entries and recover them at startup. Unify log/payload queues on a bounded queue abstraction and partition drop reasons.

### G-24 — Degraded/drop semantics are conflated

**Evidence:**

- event queue uses byte/count limits in `src/persistence/telemetry/pipeline.ts:335-355`;
- log/payload queues use separate caps and `Array.shift()`;
- `dropped` increments for overflow and retry eviction;
- `degraded` clearing depends on event flush/Redis state rather than all write paths.

**Gap:** operators cannot distinguish burst overflow, downstream failure, retry eviction, or Redis degradation. A single failure can make status sticky or misleading.

**Proposal:** expose partitioned counters: `droppedOverflow`, `droppedRetryEviction`, `writeFailures`, `retryingByKind`, and `degradedReason`. Keep legacy aggregate `dropped` as a compatibility sum only.

### G-25 — Migration integrity is weaker than it appears

**Evidence:**

- `src/persistence/migrate.ts:45-92` loads journal entries and Drizzle hashes;
- `src/persistence/migrate.ts:134-170` compares ledger metadata;
- `src/persistence/migrate.ts:179-232` uses blocking `pg_advisory_lock` and per-migration transactions;
- SQLite schema migration in `src/persistence/telemetry/store/sqlite/schema.ts:74-95` catches all ALTER errors;
- D1 has no equivalent automatic ensure/apply path.

**Gap:** raw SQL checksum semantics are tied to Drizzle’s parsed representation; SQLite syntax errors can be swallowed as if a column already existed; concurrent migration callers block indefinitely; D1 freshness depends on manual setup.

**Proposal:** checksum raw SQL plus parsed hash, use bounded `pg_try_advisory_lock`, rethrow non-duplicate SQLite ALTER errors, and give D1 a versioned ensure path. Keep the migration journal as the PG source but test schema parity separately.

### G-26 — Retention is bounded per tick and timestamp semantics differ

**Evidence:**

- `src/persistence/telemetry/retention.ts:7-17,34-35` uses bounded deletes and SQLite space timestamps;
- `src/persistence/telemetry/store/d1/writer.ts:338-339` uses ISO timestamps;
- `src/persistence/telemetry/pipeline.ts:130` starts retention through a timer path.

**Gap:** large stale backlogs require many ticks; D1/SQLite timestamp formats differ; retention errors are swallowed and residue is not surfaced.

**Proposal:** centralize epoch/cutoff semantics, report residue, run bounded catch-up loops, and start retention scheduling eagerly. Add tests with >10,000 stale rows.

## 7. Runtime/Operational Gaps

### G-27 — Startup and readiness have race-prone background work

**Evidence:**

- `src/bootstrap/bootstrap.ts:22-36` creates persistence/app ports and then checks readiness;
- `src/bootstrap/persistence.ts:37-50` starts telemetry, coordination, migrations, and background catalog refresh concurrently;
- `src/bootstrap/proxy-port.ts:65-100` runs catalog refresh fire-and-forget.

**Gap:** first requests can race telemetry opening or catalog refresh. Errors from advisory catalog refresh are silently treated as static fallback. Readiness also re-pings the database on every check.

**Proposal:** expose explicit readiness promises for telemetry and essential catalog state. Surface degraded-but-servable catalog state. Cache readiness for a short bounded interval while retaining a forced check for operators.

### G-28 — Shutdown lacks graceful drain and signal-handler cleanup

**Evidence:**

- `src/bootstrap/bootstrap.ts:57-71` installs process signal handlers without removing them;
- server stop occurs without a confirmed in-flight drain;
- `src/runtime/in-flight.ts:114-121` has pending GC cleanup edge cases;
- `src/persistence/pool.ts:75-82` closes a replaced pool fire-and-forget.

**Gap:** repeated starts leak handlers; active streams can be truncated; old pools can overlap during hot reload; pending GC can suppress later collection.

**Proposal:** make shutdown a first-class drain state: stop admission, stop accepting new work, wait bounded time for in-flight requests, flush telemetry/spool, then close pools. Track/remove signal handlers and reset pending GC state.

### G-29 — Redis fallback can double-count and lose cross-instance invalidation

**Evidence:**

- `src/persistence/coordination.ts:105-147` falls back locally after Redis failure;
- local fallback is mutated before Redis attempt in rate/in-flight paths;
- subscriptions remain local even in Redis mode;
- `src/persistence/telemetry/cache/*` has separate memory/Redis TTL behavior.

**Gap:** Redis success can leave local counters inflated; degraded mode is sticky; route invalidation is not reliably cross-instance; TTLs differ by cache layer.

**Proposal:** mutate only the selected authority, re-probe Redis periodically, make degraded reason explicit, and define single-instance behavior when shared coordination is unavailable. Align cache TTL/invalidation semantics.

### G-30 — Quota, credential lease, and management paths use different eligibility rules

**Evidence:**

- proxy path uses `CredentialSelector` and leases;
- `src/console/services/providers.ts:487-570` discovery loops call credentials directly;
- management validation/quota paths do not consistently apply health/cooldown/model-lock eligibility;
- `src/bootstrap/quota.ts:63-190` owns separate quota/token-refresh lifecycles.

**Gap:** an account cooling down or quota-exhausted for routing can still be used by discovery/validation, creating extra upstream pressure and misleading operator status.

**Proposal:** expose one account eligibility service and require management paths to use it, with an explicit force-diagnostic override. Unify lease ownership so routing and quota do not each partially own the same lifecycle.

## 8. Console/Observability Gaps

### G-31 — `/console/api/ips/top` bypasses privacy presentation

**Evidence:**

- `src/console/services/observability.ts:336-353` returns aggregate IP rows without `presentClientIp`;
- logs and usage paths do use the privacy snapshot.

**Gap:** masked privacy mode can still expose raw IPs through the top-IP endpoint.

**Proposal:** apply the same read-time presentation transform to `ips.top`. Add a contract test covering full/masked modes while storage remains raw.

### G-32 — Payloads and telemetry metadata are overexposed to any console session

**Evidence:**

- `src/console/services/observability.ts:88-132` returns payload artifacts in detail;
- `src/console/routes/system.ts:232-244` exposes payload retrieval to an authenticated console session;
- `src/persistence/telemetry/store/interface.ts:18-25` stores bounded but potentially sensitive artifacts.

**Gap:** payloads can contain PII, tool inputs, or accidental credential echoes. The console has a shared session boundary and no explicit payload-read consent/audit contract.

**Proposal:** make payload inclusion explicit (`withPayload=true`), scrub credentials on save, return expiration/truncation metadata, and audit payload reads. Keep metadata-only detail as the default.

### G-33 — Console Logs SSE is poll-based and lacks replay/backpressure semantics

**Evidence:**

- `src/console/services/observability.ts:176-236` polls `queryLogs` every second and emits ping;
- no Last-Event-ID/id replay contract is present;
- controller backpressure is not checked.

**Gap:** DB polling adds load; reconnects can miss gaps; a slow consumer can accumulate data; active SSE sessions have no explicit cursor protocol.

**Proposal:** add SSE event IDs and Last-Event-ID/afterId replay, enforce `desiredSize` backpressure, and optionally use Redis stream push where available with polling fallback. Keep the current SQL-backed snapshot as the recovery path.

### G-34 — Privacy refresh is fire-and-forget and can stale-win

**Evidence:**

- `src/runtime/privacy.ts:15-34` swallows DB read failures and defaults masked;
- `src/bootstrap/console-wiring.ts:56` invokes refresh fire-and-forget;
- `src/console/services/console-settings.ts:25,64,90` calls mutation callback after all settings changes.

**Gap:** rapid mutations can race; a slower old read can overwrite a newer mode. Refresh failures are invisible. Proxy-settings-only changes cause unnecessary privacy reads.

**Proposal:** serialize/debounce refreshes, log failures, and invoke only for privacy-affecting mutations. Keep masked as safe fallback but expose degraded state to diagnostics.

### G-35 — Probe lifecycle is still a synthetic second contract

**Evidence:**

- `src/console/services/probe.ts:189-233` manually crafts console messages;
- normal proxy lifecycle uses `src/bootstrap/request-log-format.ts` and `ProxyRequestLogEvent`;
- probe uses a separate `NetworkSelector` and does not run the normal retry/route plan.

**Gap:** probe logs can differ from `/v1` logs and do not show route switches. Probe network health criteria differ from proxy routing. Probe provider failures intentionally return HTTP 200 with `data.ok=false`, which can confuse generic clients.

**Proposal:** either make probe an explicit diagnostic surface with its own typed lifecycle schema, or reuse shared route/account/telemetry helpers. Keep the HTTP-200 diagnostic contract documented if retained, but expose provider failure in a stable field and never let it masquerade as a successful provider request.

## 9. Legacy and Duplicate Paths — Proposed Drop List

The following are candidates for removal only after the canonical replacement is wired and verified:

| Candidate | Current owner | Cutover condition | Action |
|---|---|---|---|
| `src/proxy/request/resilience.ts` | `src/proxy/events/commit.ts` | no production imports; retry tests moved | delete or rename remaining hedge-only code |
| `src/proxy/request/compression-pipeline.ts` | `src/proxy/request/prepare.ts` | no imports/tests depend on old API | delete |
| `attempt.ts` stream release wrapper | `commit.ts` commit/release gate | shared gate owns release exactly once | delete duplicate wrapper |
| `src/bootstrap/proxy-port.ts` inline route snapshot | `accounts.ts`/canonical RouteSnapshot service | production integration uses canonical loader | delete inline builder |
| `plan.ts` duplicate snapshot cache | canonical RouteSnapshot service | plan consumes injected snapshot only | reduce to pure route planning |
| `CACHED_BODY_LIMIT`, `CACHED_TRUST_PROXY` exports | runtime config accessors | no imports outside owner; deprecation period complete | remove compatibility exports |
| `legacyFailure()` shape handling | typed `InternalFailure` | telemetry proves no old shape | remove after deprecation window |
| duplicate detection import/re-export path | `src/proxy/normalize/detection.ts` | all callers use owner | delete re-export |
| duplicated capability projection | one policy/projection module | all callers migrated | merge/delete duplicate |
| PG telemetry mirror indexes/tables | SQLite/D1 telemetry authority | backup/migration inventory complete | deprecate, then remove only in a planned migration |
| hardcoded migration counts | journal-derived status | tests use derived expected version | replace fixed assertions |
| blanket knip ignores | explicit generated-file ignore list | dead-code report clean | narrow/remove ignores |

Do not delete these paths before the corresponding cutover condition is mechanically checked. The goal is a clean cutover, not a second compatibility layer.

## 10. Target Architecture — After Finalization

```text
RuntimeConfig (single effective config)
   │
   ├─ Limits + admission + coordination
   ├─ Readiness + graceful shutdown
   ├─ Privacy snapshot
   └─ diagnostics/effective-config view

ProviderIdentityRegistry
   ├─ builtin IDs (reserved, code-owned)
   └─ custom IDs (DB-owned, validated, disjoint)
          │
          └─ ProviderCatalogService
                 ├─ static adapter models
                 ├─ persisted enabled/metadata state
                 └─ custom models

RouteSnapshotService (single loader/cache)
   ├─ providers/models/aliases/combos
   ├─ accounts/health/locks/quota eligibility
   └─ proxies/health

RequestExecutor (single production path)
   ├─ typed authorization snapshot
   ├─ required admission
   ├─ capability preflight
   ├─ one deadline
   ├─ one retry policy
   ├─ one commit gate
   ├─ one lease/release owner
   └─ one terminal lifecycle state

LifecycleEventSink
   ├─ Console Logs: incoming/switch/complete/failed/aborted trace
   ├─ Telemetry fact: one terminal request row
   └─ Probe: same schema with surface=probe

TelemetryAuthority
   ├─ SQLite default or D1 configured
   ├─ shared row codec/schema contract
   ├─ durable optional spool
   ├─ read-time privacy presentation
   └─ native backup/restore
```

### 10.1 Canonical request lifecycle

```text
Ingress
  │
  ├─ resolve client identity and trusted IP
  ├─ authenticate API key
  ├─ build immutable authorization/admission snapshot
  ├─ emit incoming lifecycle event
  │
Prepare
  │
  ├─ parse/normalize
  ├─ capability preflight
  ├─ create/retrieve one RouteSnapshot
  └─ start one total deadline
  │
Attempt loop
  │
  ├─ select eligible candidate/account/proxy
  ├─ acquire lease/concurrency
  ├─ call provider
  ├─ before commit: retry if policy allows
  ├─ after commit: never retry
  └─ emit switch for every actual route transition
  │
Terminal
  │
  ├─ complete
  ├─ failed
  └─ aborted
  │
Commit
  │
  ├─ one response serializer
  ├─ one telemetry terminal fact
  └─ one console lifecycle trail
```

## 11. Recommended Cutover Plan

### Phase 0 — Protect production boundaries (P0)

1. Wire `ApiKeyAdmission` into the production proxy path.
2. Carry complete API-key ACL/limit authorization into `executeProxyRequest`.
3. Enforce probe account/provider ownership.
4. Stop trusting x-real-ip when no trusted proxy is configured.
5. Remove session token from login/setup JSON.
6. Unify secure cookie construction and add console CSRF/rate-limit policy.
7. Fail closed for share guard dependency errors.
8. Bound upstream provider-code serialization.
9. Pin/revalidate outbound DNS destination.

**Gate:** security-focused integration tests and a live `/v1` admission/ACL test pass.

### Phase 1 — Make request execution explicit

1. Make authorization, admission, route snapshot, deadline, telemetry, and commit state typed required dependencies.
2. Fix stream terminal classification.
3. Wire the single commit gate into retry decisions.
4. Centralize reasoning/cache-write usage extraction.
5. Ensure failed terminal logs carry the actual selected account/proxy.
6. Populate `switch.toAccountId` from the replacement candidate or defer emission until selection is known.

**Gate:** normal, retry, stream-error, client-abort, and post-commit tests pass with identical console/telemetry terminal semantics.

### Phase 2 — Collapse provider/catalog authorities

1. Introduce reserved builtin/custom identity validation.
2. Add provider alias normalization.
3. Create one ProviderCatalogService.
4. Make persisted model enabled/metadata state affect routing.
5. Wire custom provider mutation to adapter reconciliation and route snapshot invalidation.
6. Remove orphan custom accounts transactionally and add integrity migration.
7. Decide whether extensibility columns are implemented or removed.

**Gate:** create/update/delete custom provider and immediate route behavior work without restart or TTL wait; disabled models are not routable.

### Phase 3 — Collapse persistence/telemetry drift

1. Choose SQLite/D1 as the explicit runtime telemetry authority.
2. Add shared row codec/schema and parity checks.
3. Fix migration checksum/lock/error semantics.
4. Add D1 schema ensure/versioning.
5. Add optional durable telemetry spool.
6. Normalize retention cutoff/deletion behavior.
7. Make backup/restore use native telemetry export/import.

**Gate:** crash/restart recovery, D1/SQLite parity, migration idempotency, and backup round-trip pass.

### Phase 4 — Runtime operations and console hardening

1. Make readiness depend on all required stores.
2. Add graceful request drain and signal cleanup.
3. Re-probe Redis and expose degraded reason.
4. Unify quota/account eligibility.
5. Apply privacy presentation to every IP-returning endpoint, including top IPs.
6. Add SSE IDs/replay/backpressure.
7. Make payload reads explicit and audited.

**Gate:** chaos smoke tests for dependency failure, shutdown, SSE reconnect, and privacy flips pass.

### Phase 5 — Delete legacy weight

1. Move tests to canonical modules.
2. Run import/reference checks.
3. Delete legacy retry/compression/snapshot/stream wrappers.
4. Narrow knip ignores.
5. Remove fixed migration/provider counts and stale compatibility comments.
6. Update docs and changelog atomically.

**Gate:** no production imports of deleted paths; full source/dashboard test suites pass.

## 12. Verification Matrix

| Contract | Required proof |
|---|---|
| API-key admission | live request exceeds each configured limit and is rejected before provider call |
| API-key ACL | denied provider/model never reaches adapter dispatch |
| Client identity | spoofed forwarded headers cannot evade bans/rate limits when trust disabled |
| Probe account ownership | mismatched account/provider fails without credential use |
| Stream terminal state | complete/failed/aborted classification matches telemetry and HTTP behavior |
| Commit invariant | post-commit provider failure never retries |
| Provider namespace | builtin slug collision returns 409; case variants are deterministic |
| Custom mutation | create/update/delete takes effect without restart and without orphan routes |
| Catalog authority | disabled model is absent from both dashboard and routing |
| Telemetry parity | SQLite and D1 encode/decode identical rows and context |
| Telemetry durability | crash before flush recovers when durable spool is enabled |
| Migration safety | concurrent migration caller fails bounded; SQLite/D1 drift is visible |
| Privacy | every IP-returning console endpoint masks/unmasks consistently; storage remains raw |
| Payload security | credentials are scrubbed and payload reads are explicit/audited |
| SSE | reconnect with cursor receives missed rows without duplicates; slow consumer is bounded |
| Shutdown | new admission stops, in-flight drains, telemetry flushes, handlers/pools close once |

## 13. Final Recommendation

The project is not fragile because it lacks more abstractions. It is fragile because several abstractions exist in parallel and production composition does not always select the canonical one.

The finalization standard should therefore be:

```text
No second implementation
No optional production security control
No free-text identity crossing an ownership boundary
No database schema without a runtime owner
No runtime contract without a composition test
No legacy path without a deletion date and import check
```

The immediate stop-ship items are G-01 through G-11. The highest architectural follow-up is the combination of G-13, G-14, G-15, G-17, and G-20: route snapshot, provider identity, catalog, mutation invalidation, and duplicate execution paths must be cut over together. Fixing only one of those will leave the same class of drift in place.

The report should be treated as a finalization backlog, not as permission to implement every proposal opportunistically. Each phase needs an explicit contract, migration/cutover owner, focused regression tests, and a deletion check for the old path.
