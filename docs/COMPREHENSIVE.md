# Oh My Omop - Router — Comprehensive Documentation

> Single comprehensive doc: full Mermaid + ASCII + tables, detailed per section. Flow request → client as primary example, other sections differentiated below.

## Table of Contents
- [1. Request Flow (end-to-end)](#1-request-flow-end-to-end)
- [2. Architecture & Ownership](#2-architecture--ownership)
- [3. Routing](#3-routing)
- [4. Translation](#4-translation)
- [5. Operations](#5-operations)
- [6. Providers](#6-providers)
- [7. Quality](#7-quality)
- [8. API](#8-api)

---

## 1. Request Flow (end-to-end)

```mermaid
sequenceDiagram
  participant C as Client
  participant G as Guard (api/guard.ts)
  participant N as Normalize (openai/anthropic/gemini)
  participant R as Router (plan.ts + snapshot)
  participant A as Account/Network (lease)
  participant P as Provider (adapter.call)
  participant T as Transport (SSE/Abort)
  participant S as Surface (stream.ts)
  C->>G: POST /v1/* + Bearer/x-api-key + JSON body
  G->>G: computeBodyLimit + readBoundedJson(requestId) + auth + IP ban
  G->>N: ProxyIngressContext(requestId, FormatDetectionResult, ClientIdentity)
  N->>R: ProxyRequest(ordered ContentPart, ToolChoice, ResponseFormat) + RequiredRouteCapabilities
  R->>R: CLI mapping (allowlist) -> alias -> combo (fallback/round-robin BoundedRouteSessionStore)
  R->>A: pre-lease capability filter (resolveModelWireSurface) -> lease account/network
  A->>P: remaining total deadline + AbortCoordinator
  P->>T: fetch + SSRF check + SSE parse (STREAM_BOUNDS)
  T->>S: canonical events (lifecycle gate: 1 start, valid tool names, 1 usage, 1 stop)
  S-->>C: 200 JSON or text/event-stream + x-request-id + no-store
  alt pre-commit error
    S-->>C: {error:{type:error,code,request_id}}
  else post-commit
    S-->>C: typed stream terminal (no second JSON)
  end
```

```text
ASCII:
Client --JSON/SSE--> Guard(bodyLimit 10MiB, auth, IP) --ProxyIngressContext(requestId)--> Normalize --RequiredRouteCapabilities+mappedModel--> Plan(alias 8 depth, combo fallback/round-robin 256 LRU, bare-model ambiguous) --capability filter--> Lease(account/quota/health) + Network(proxy) --remaining deadline--> Provider --SSE(64KiB line/event, 512KiB buffered, 100k events, 10MiB cumul) + Abort(connect/firstByte/idle/total) --> Lifecycle(one start, valid tools, one usage, one stop) --> Surface(typed frames) --> Client + Telemetry(SQLite/D1)
```

| Phase | Owner | Bounds |
|---|---|---|
| Guard | src/api/guard.ts | body 10MiB [64KiB-64MiB], rate 100/60s, IP ban 10/6h |
| Normalize | src/proxy/normalize/* | MAX_MODEL 256, MAX_MESSAGE 2048, MAX_TOOL 128 |
| Plan | src/proxy/routing/plan.ts | MAX_ALIAS_DEPTH 8, MAX_DIAGNOSTICS 32, MAX_CANDIDATES 64, cache 256 LRU |
| Transport | src/proxy/transport/sse.ts | 64KiB line/event, 512KiB buffered, 100k events, 10MiB stream |
| Telemetry | src/persistence/telemetry/pipeline.ts | ring 5k/1MiB, chunk 500, eager 100/256KiB |

---


> Merged: Architecture + Routing + Translation — ownership, request path, routing order, translation contracts.

```mermaid
flowchart LR
  Client --> Guard --> Normalize --> Map --> Plan --> Provider
  Provider --> Transport --> Stream --> Surface --> Client
  Plan -.-> Snapshot & Cache
  Provider -.-> Telemetry
```

```text
ASCII: Client -> Guard(auth/body) -> Normalize(openai/anthropic/gemini) -> CLI Mapping -> Plan(alias/combo/capability) -> Account/Network -> Provider -> SSE/Abort -> Lifecycle -> Surface
```

## 1. Ownership Map

```text
src/bootstrap   composition, runtime config, proxy port, console wiring and lifecycle
src/api         public `/v1/*` boundary, guards and surface dispatch
src/console     authenticated console router and service ports — orchestrator `src/console/api.ts` composes domain routers `src/console/routes/{auth,providers,accounts,catalog,proxies,observability,system}.ts` + `src/console/wireguard-helpers.ts` (Phase 4.1)
src/proxy       single source of truth — canonical proxy boundary: `types/*` + `normalize/*` (openai/chat|responses|reasoning + anthropic/normalize|payload|response + detection/tools; barrels at normalize/openai.ts + normalize/anthropic.ts) + `translate/*` (request/response/policy/cross-surface/stream/cache single owner + passthrough) + `events/*` (assembly/lifecycle/commit/repair/tool-assembler/signature) + `transport/*` (sse/abort/fetch/network/errors/response) + `routing/*` (plan/account/mapping/capability) + `request/*` (prepare/attempt/execute) + `upstream/*` (openai/anthropic/gemini/adapter) + `policy/*` (profiles/projection) + `protocol-request.ts`
src/providers   registry 47 defs (10 oauth+37 api_key, 41 eager +5 lazy →46) + catalog/discovery (`fetch-models.ts` + inline `oauth-provider/cursor.ts:GetUsableModels` http2 + `oauth-provider/devin.ts:GetCliModelConfigs` protobuf) + quota fetch (see PROVIDERS.md)
src/auth        OAuth driver registry, login sessions, refresh and bounded OAuth HTTP
src/compression Ponytail, RTK, token saving and filter policy
src/persistence PostgreSQL repositories plus SQLite/D1 telemetry pipeline and store-side aggregates
src/runtime     version, limits, admission, concurrency, in-flight state and overhead
```

There are no active `src/application`, `src/codec`, `src/traffic`, or PostgreSQL telemetry layers (`src/proxy/transport` IS active for SSE/fetch/SSRF). There is no `src/proxy/openai.ts` monolith and no duplicate planner in `src/proxy/routing/model-chain.ts` — imports target direct owners (`src/proxy/normalize/openai.ts` barrel + `src/proxy/normalize/openai/{chat,responses,reasoning}.ts` splits, `src/proxy/normalize/anthropic.ts` barrel + `src/proxy/normalize/anthropic/{normalize,payload,response}.ts` splits, `src/proxy/translate/request.ts`, `src/proxy/translate/cache.ts` single cache owner (request.ts re-exports), `src/proxy/translate/response.ts`, `src/proxy/upstream/dispatch.ts` shared coordinator, `src/proxy/routing/plan.ts`). Tool repair lives only in `src/proxy/normalize/tools.ts:repairToolCallRequest` and `src/proxy/events/repair.ts`. Import domain symbols directly from their owning files; barrels exist only at `normalize/openai.ts` and `normalize/anthropic.ts` for backwards compat (Phase 4.2/4.3).

## Protocol ownership (direct modules)

## 2. Request Path

```text
main.ts
  → bootstrap/bootstrap.ts
  → loadRuntimeConfig + PostgreSQL pool/migrations/readiness
  → coordination (Redis when configured, local bounded fallback)
  → telemetry pipeline (D1 when URL+token exist, otherwise SQLite)
  → default provider registry
  → proxy port
  → public guard/auth/body limit (readBoundedJson uses ProxyIngressContext.requestId)
  → single ingress detection → ProxyIngressContext (one requestId, one FormatDetectionResult, one ClientIdentity, endpoint, apiKeyId, disableRemoteMapping)
  → normalization (openai-normalize / anthropic / gemini → ordered ProxyRequest with ToolChoice + ResponseFormatConstraint)
  → CLI mapping (resolveCliModelMapping with allowlist gate, trim+case-fold, Claude family) then route plan
  → route snapshot / aliases / combos / RequiredRouteCapabilities pre-lease filtering
  → account, credential and network selection (only after capability filtering)
  → provider adapter.call
  → upstream fetch + SSRF + AbortCoordinator
  → canonical stream events (lifecycle gate validates order)
  → surface encoder (single public error envelope pre-commit; stream terminal post-commit)
  → response and telemetry finalization
```

`RequestLimits` is the single request framing contract: body (`OHMYOMOP_ROUTER_MAX_REQUEST_BODY_BYTES` 10MiB clamped 64KiB–64MiB), connect, first-body, idle, and total timeout values. The ingress body limit is enforced dually — `src/api/guard.ts:computeBodyLimit()` reads live env per request for `readBoundedJson`, and the same value is propagated as `RequestLimits.maxBodyBytes` for translation/provider validation (`boundedIntegerFromEnv` in `src/runtime/runtime.ts:132` + `src/proxy/transport/sse.ts:STREAM_BOUNDS`). The total deadline is created once before provider attempts. Each attempt receives the remaining total budget; retries cannot extend the request deadline.

`ProxyIngressContext` is threaded through `ProxyRequestPort.handle`, `src/api/v1.ts:handleProxy`, `src/proxy/request/execute.ts:handleProxyPortRequest/runProxyRequest`, `prepareProxyRequest`, and `createProxyPort` — no second detection in the live path, no second requestId. `src/proxy/normalize/detection.ts` precedence is explicit recognized helper/header, recognized client UA, body shape, earliest recognized bounded system/developer marker, endpoint; arbitrary UA is `rawUserAgent` only. Conflicts among bounded marker/body/endpoint/recognized UA are recorded without prompt text.

## Stream behavior

## 3. Protocol Ownership

```text
src/proxy/types/content.ts               ContentPart (ordered, discriminated: text/image/pdf/video/tool_use/tool_result/reasoning/compaction/native/unknown), NormalizedTool union (function/hosted/native/opaque), NormalizedMessage
src/proxy/types/request.ts               ProxyRequest (ordered ContentPart + ToolChoice + ResponseFormatConstraint), ProxyIngressContext (single requestId + FormatDetectionResult + ClientIdentity + endpoint + apiKeyId + disableRemoteMapping), ToolChoice, ResponseFormatConstraint
src/proxy/types/stream.ts                StreamEvent + terminal outcome (completed/incomplete/failed/cancelled) — isTerminalEvent only on final message_stop
src/proxy/types/routing.ts               RequiredRouteCapabilities (tools/hostedSearch/reasoning/image/pdf/video/responseFormat/sourceSurface), ProxyRoutePlan with failureCode
src/proxy/normalize/openai.ts            barrel → normalizeChatRequest (openai/chat.ts) / normalizeResponsesRequest (openai/responses.ts) + REASONING_EFFORTS/parseReasoningConfig (openai/reasoning.ts)
src/proxy/normalize/anthropic.ts         barrel → normalizeMessagesRequest (anthropic/normalize.ts) / buildMessagesPayload (anthropic/payload.ts) / translateAnthropicResponse (anthropic/response.ts)
src/proxy/translate/cache.ts             CachePlan, shouldBuildCachePlan, markCacheSections, applyCachePlan, findCacheBreakpoint, resolvePromptCacheKey (single owner)
src/proxy/translate/request.ts           buildChatPayload / buildResponsesPayload / toResponsesTool / toResponsesItem (re-exports cache symbols)
src/proxy/translate/response.ts          translateOpenAIChatResponse / translateOpenAIResponsesResponse
src/proxy/upstream/dispatch.ts           dispatchWithCoordinator — shared fetch + AbortCoordinator + SSE mapping for openai/anthropic/gemini adapters (Phase 4.4)
src/proxy/events/assembly.ts             foldResponseEvents + orderedResponseItems (single ordered fold for non-stream)
src/proxy/normalize/tools.ts             normalizeToolList (structural kind classifier), repairToolCallRequest (sole ID/orphan repair)
src/proxy/normalize/detection.ts         single ingress detection — explicit header > recognized UA > body shape > earliest bounded marker > endpoint; conflicts recorded without prompt text
src/proxy/translate/cross-surface.ts     cross-surface translateResponseDocument (full fold, rejects nonrepresentable opaque/native/context)
```

Canonical types: `ContentPart` reasoning retains visible text, summary, opaque encrypted payload, signature, raw source item and source surface in order; internal side channels (`reasoningContent`, `reasoningItemsBefore`, `reasoningItems`, `trailingReasoningItems`) are deleted. `ToolChoice` is `auto|none|required` or `{kind:"function", name}`; `ResponseFormatConstraint` is `text|json_object|json_schema{ schema }` (single field, not `responseFormat`+`responseFormatSchema`). `isWebSearchTool` matches only `kind:"hosted"` + `hostedType:"web_search"`; a function named `web_search` is never rerouted.

Capability projection: every payload builder (`buildChatPayload`, `buildResponsesPayload`, `buildMessagesPayload`, `buildGeminiPayload`) projects each canonical tool/choice/parallel/format value — emitting the legal target equivalent or throwing `ProtocolCodecError` with `capability_unsupported` before provider dispatch (no silent downgrade).

## Version identity

## 4. Routing

## Ownership

```text
src/proxy/routing/plan.ts          facade and route-plan entry point (re-exports isWebSearchTool with NormalizedTool type)
src/proxy/routing/plan.ts           single recursive resolver — snapshot sources, alias/combo expansion, bare-model index, capability filtering, BoundedRouteSessionStore (`routePlanCache` WeakMap 256 LRU, `MAX_ALIAS_DEPTH 8`, `MAX_DIAGNOSTICS 32`, `MAX_CANDIDATES 64`)
src/proxy/translate/cache.ts        single cache-plan owner (CachePlan, shouldBuildCachePlan, markCacheSections, buildCachePlan, applyCachePlan, findCacheBreakpoint, resolvePromptCacheKey; request.ts re-exports for compat)
src/proxy/routing/model-chain.ts    legacy alias helper only — live expansion deleted; plan.ts is the sole resolver
src/proxy/routing/account.ts    tool-scoped CLI model mappings (resolveCliModelMapping with allowlist gate)
src/proxy/routing/account-state.ts  health, isWebSearchTool(NormalizedTool) and model-lock ports
src/proxy/routing/session-state.ts  bounded route/session affinity state (not round-robin)
src/proxy/request/           prepare, capture, attempt and executor lifecycle
src/proxy/types/routing.ts RequiredRouteCapabilities (tools/hostedSearch/reasoning/image/pdf/video/responseFormat/sourceSurface), ProxyRoutePlan diagnostics/failureCode, RouteSessionState
src/proxy/normalize/detection.ts     single ingress format detection (precedence for planner ordering)
src/auth/                     OAuth driver registry, sessions and refresh
```

`src/persistence/persistence-api.ts` supplies repository-backed models, aliases, combos, CLI mappings, accounts and proxies. PostgreSQL remains the durable source; the router consumes injected ports rather than issuing SQL directly. No duplicate repair/planner remains (`repairToolCallRequest` is only in `src/proxy/normalize/tools.ts`; combo/alias expansion is only in `plan.ts`).

## Effective order (detection → mapping → planner)

```text
ProxyIngressContext (single requestId + FormatDetectionResult + ClientIdentity + endpoint + apiKeyId)
  → prepareProxyRequest (ordered ContentPart + ToolChoice + ResponseFormatConstraint + repair)
  → RequiredRouteCapabilities derived immediately after preparation
  → resolveCliModelMapping(client, sourceModel, apiKeyId, mappings) → raw + mapped model
  → createRoutePlan({ requestedModel: mapped, rawRequestedModel, mappedModel, sourceSurface, requiredCapabilities, snapshot, affinityKey, routeSessionStore })
  → pre-lease capability filtering + wire-surface resolution (resolveModelWireSurface) before any account/network lease
```

CLI mapping allowlist gate (`src/proxy/routing/account.ts:resolveCliModelMapping` + `src/proxy/types/request.ts:ProxyIngressContext` + `src/persistence/repositories/routing-config.ts`):

- `CliModelMappingSnapshot.allowedApiKeyIds` present (including `[]`) → only listed authenticated `apiKeyId` may use the mapping (empty = no key allowed).
- `allowedApiKeyIds` absent (`undefined`, legacy in-memory fixtures) → unrestricted.
- Disabled mapping or unallowlisted/disabled key → returns raw requested model.
- Trim + case-fold `sourceModel` for every client; Claude additionally family-matches (`opus|sonnet|haiku|fable|mythos`).

## Route snapshot

A route snapshot combines provider models, aliases, combos, CLI mappings, accounts, proxies, account health, quota and model locks. The snapshot cache deduplicates concurrent rebuilds and is invalidated immediately after routing mutations. Repository composition exposes `invalidateRouteSnapshot()` for local invalidation; coordination revision publication handles multi-instance refresh when wired.

Combo lookup is by persisted combo **ID** in both `src/persistence/repositories/routing-config.ts` snapshots and `src/bootstrap/proxy-port.ts` (display `name` stays display-only).

## Plan construction

1. Single ingress detection already in `ProxyIngressContext` (explicit recognized header/helper > recognized UA > body shape > earliest bounded marker > endpoint; conflicts recorded).
2. CLI mapping via `resolveCliModelMapping` with allowlist gate and trim/case-fold (+ Claude family).
3. Alias resolution with one active-path set, cycle and `MAX_ALIAS_DEPTH 8` guards, `MAX_DIAGNOSTICS 32`.
4. Combo expansion — fallback keeps configured member order; round-robin rotates via `BoundedRouteSessionStore` (see below); recursive resolution with shared depth/diagnostics/duplicate-removal; duplicate candidates removed.
5. Qualified `provider/model` parse and bare-model index resolution (see Invariants). Wire surface resolved via `resolveModelWireSurface` policy + model metadata (`surface: openai-chat` hardcoded removed) during plan construction.
6. Pre-lease `RequiredRouteCapabilities` filtering (tools, hosted search, reasoning, image/pdf/video parts, response format, required projection) — candidates that cannot accept/project are removed before account/network selection; `selectWireSurfaceAttempt` only asserts the planned wire surface.
7. Apply cache classification and stable-prefix metadata; select eligible account candidates using health, cooldown, quota, locks and affinity (rendezvous).

Aliases and combos are bounded. A malformed cycle or empty combo produces a typed diagnostic instead of unbounded recursion. Diagnostics include `ambiguous_model` and `capability_unsupported`.

### Persisted strategies

- **Fallback** — uses configured member order exactly (no reordering).
- **Round-robin** — via `BoundedRouteSessionStore<{nextIndex, uses}>` instantiated in `createProxyPort` (bounded session pattern: 256 entries, 30-minute idle TTL). Key is `revision\u0000comboId\u0000affinity` (affinity = `namespace:value`). On each plan, rotation advances `nextIndex`; after `sticky_limit` selections (positive persisted value) `nextIndex` advances and `uses` resets. Instantiated per proxy process; revision part of key discards prior rotation on config change. In `plan.ts` `resolveTargets` order for round-robin is `members.slice(nextIndex) + slice(0,nextIndex)` then store update; fallback is not rotated.

## Request execution

```text
prepareProxyRequest
  → normalize body using injected RequestLimits
  → create one total deadline
  → derive RequiredRouteCapabilities + mapped model + wire surface (plan-time, pre-lease)
  → select/lease candidate
  → refresh OAuth credential when required
  → select network/proxy
  → adapter.call with remaining total timeout (wire surface already planned)
  → canonical output/stream events (lifecycle gate)
  → release lease in finally
```

The total request deadline covers all attempts. Before every provider call, the executor computes remaining time and passes the smaller of the provider-configured total timeout and remaining request budget. If no time remains, it raises a retryable timeout without starting another provider. Route metadata stores four identities: raw requested model, CLI-mapped model, selected `providerId/modelId`, and `RouteTarget.upstreamModelId` plus planned wire surface — through `RequestRoutingMetadata` → `TelemetryFinish`/`TelemetryEvent` → `src/bootstrap/proxy-port.ts` telemetry writer → SQLite/D1 → `src/console/services/observability.ts`.

Only retryable errors can select another candidate. Non-retryable errors release the current lease and propagate immediately. Retry is also blocked after semantic stream output commits, after terminal output, when no candidates remain, or when the total deadline expires.

Pre- vs post-commit: `src/proxy/request/execute.ts:runProxyRequest` (and legacy `RequestExecutor.execute`) wrap iteration in `try/catch/finally` and settle the common outcome before telemetry. Pre-first-visible-event (including reasoning) failure → uncommitted typed HTTP error; post-commit failure → one typed stream terminal, not a 200/null telemetry success, and not retried.

## Account/auth behavior

OAuth account leases use the auth refresher's single-flight/lease/CAS path. API-key authentication uses a digest-keyed, short-TTL process cache that does not retain plaintext secrets indefinitely. Revoked/inactive records remain rejected after cache expiry.

## Invariants

- Snapshot reads are revision-consistent.
- Repository mutations invalidate local route state immediately.
- Route/session state is bounded and does not store raw prompts or credentials.
- A lease is released exactly once.
- A failed provider cannot silently become a successful truncated stream.
- **Bare-model resolution:** `modelId → sorted provider IDs`. Single owner → one candidate; multiple owners → `ambiguous_model` diagnostic, no candidate, `failureCode:"ambiguous_model"` (400 `invalid_request`), not first-provider. No owner → `model_not_found` diagnostic, `failureCode:"model_not_found"` (404). First-provider fallback deleted.
- **Pre-lease filtering:** `RequiredRouteCapabilities` + `resolveModelWireSurface` filter before lease/network; incompatibility throws `capability_unsupported` before dispatch (never discovered after lease in `selectWireSurfaceAttempt`).
- **Mapping allowlist:** `allowedApiKeyIds` present (including `[]`) is an explicit allowlist; `[]` maps no keys; absent is unrestricted (old in-memory fixtures). Source model match is trim+case-fold (every client) then Claude family.
- **Combo identity:** lookup by combo ID; `name` is display-only.

## Reproduce routing behavior

The repository includes deterministic tests for the two highest-risk routing invariants:

```sh
bun test src/proxy/routing/routing-reliability.test.ts src/proxy/routing/plan.test.ts src/proxy/request/prepare.test.ts src/proxy/routing/route.test.ts src/proxy/request/executor.test.ts --timeout 60000
```

The test demonstrates that:

1. two repository factories do not share a route-snapshot cache;
2. invalidating one repository causes its next snapshot read to hit the source again;
3. a non-retryable error invokes only the first candidate.

With a running instance, inspect the configured route inputs through the console:

```sh
curl -sS http://127.0.0.1:12800/console/api/models/aliases \
  -H "Cookie: ohmyomop_router_console=$CONSOLE_SESSION" | jq .
curl -sS http://127.0.0.1:12800/console/api/models/combos \
  -H "Cookie: ohmyomop_router_console=$CONSOLE_SESSION" | jq .
```

Create or change an alias/combo in the dashboard, then repeat the request. The next route snapshot must reflect the mutation without waiting for the normal snapshot TTL.

## 5. Translation

## Ownership

```text
src/proxy/types/*            canonical request/content/provider/routing/error/stream/telemetry shapes
src/proxy/types/content.ts    ContentPart ordered union, NormalizedTool (function/hosted/native/opaque), ToolChoice, ResponseFormatConstraint
src/proxy/types/request.ts    ProxyRequest (ordered parts), ProxyIngressContext, ClientIdentity
src/proxy/types/stream.ts      StreamEvent + terminal outcome (completed/incomplete/failed/cancelled)
src/proxy/types/routing.ts     RequiredRouteCapabilities + ProxyRoutePlan
src/proxy/normalize/detection.ts       single ingress detection (header > recognized UA > body shape > bounded marker > endpoint)
src/proxy/normalize/openai.ts          Chat + Responses normalization (content/tool/reasoning/controls) — barrel re-exporting openai/chat.ts + openai/responses.ts + openai/reasoning.ts (Phase 4.2)
src/proxy/translate/cache.ts            CachePlan, shouldBuildCachePlan, markCacheSections, buildCachePlan, applyCachePlan, findCacheBreakpoint, resolvePromptCacheKey (single owner; request.ts re-exports for backwards compat)
src/proxy/translate/request.ts          buildChatPayload / buildResponsesPayload / toResponsesTool / toResponsesItem (cache logic owned by cache.ts)
src/proxy/translate/response.ts         translateOpenAIChatResponse / translateOpenAIResponsesResponse
src/proxy/events/assembly.ts            foldResponseEvents + orderedResponseItems (ordered canonical fold)
src/proxy/upstream/gemini.ts           Gemini payload and response transforms (buildGeminiPayload, mapGeminiUsage, translateGeminiResponse)
src/proxy/translate/cross-surface.ts    cross-surface translateResponseDocument (folded doc, typed capability rejection)
src/proxy/validation.ts                 narrowing, bounded JSON, usage and shared validation
src/proxy/translate/policy.ts           capabilities, extension policy, resolveModelWireSurface and retry policy
src/proxy/normalize/tools.ts            normalizeToolList (structural kind classifier), repairToolCallRequest (sole ledger repair) + events/repair.ts
```

Provider adapters do not invent a second request model. They receive canonical requests, emit canonical response documents/events, and own only their upstream dispatch details via `src/proxy/upstream/*` (shared `dispatchWithCoordinator` in `src/proxy/upstream/dispatch.ts` Phase 4.4). There is no `src/proxy/openai.ts` monolith — OpenAI is split across `proxy/normalize/openai.ts` (`openai/chat.ts`/`responses.ts`/`reasoning.ts`) / `proxy/translate/{request,response,cache}` / `proxy/translate/cross-surface.ts`. Tool repair lives only in `src/proxy/normalize/tools.ts:repairToolCallRequest` and `src/proxy/events/repair.ts`. Cache plan is single-owned by `src/proxy/translate/cache.ts`; `src/proxy/translate/request.ts` re-exports cache symbols to preserve existing import paths.

## Ordered request/content contract

Canonical request (`ProxyRequest` in `src/proxy/types/request.ts`):

- Ordered `ContentPart[]` per `src/proxy/types/content.ts` — `text | image | pdf | video | tool_use | tool_result | reasoning | compaction | native | unknown`. Reasoning preserves visible text, summary blocks, opaque encrypted payload, signature, raw source item, and source surface in arrival order; internal side channels (`reasoningContent`, `reasoningItemsBefore`, `reasoningItems`, `trailingReasoningItems`) are deleted.
- `NormalizedTool` discriminated union: `function { name, description, inputSchema, strict? }`, `hosted { hostedType: web_search|web_fetch, nativeOptions, raw? }`, `native { nativeType, nativeOptions, raw? }`, `opaque { nativeType, raw }`. Structural classification in `normalizeToolList` — a function named `web_search` stays `kind:"function"`; only `kind:"hosted"` participates in hosted-search policy. `isWebSearchTool` matches only `kind:"hosted"`+`web_search`.
- `ToolChoice` is `{kind:"auto"|"none"|"required"} | {kind:"function", name}`; `parallelToolCalls` is a separate optional boolean. Both Chat/Responses/Messages normalizers map into it (Anthropic `auto/none/any/named/disable_parallel_tool_use` → canonical choice). `ResponseFormatConstraint` is `text | json_object | json_schema{ schema }` — migrated from `responseFormat`+`responseFormatSchema` into one field.
- `ToolCallLedger` + `repairToolCallRequest` is the sole ID sanitation/duplicate/orphan/missing-result repair. `src/proxy/request/prepare.ts:applyFusedCompression` applies compression/filter transforms then calls `repairToolCallRequest` once — generating `toolResultIsError:true` + `No result provided` adjacent to the owning assistant message. No duplicate repair in prepare.
- Ingress is one `ProxyIngressContext` (requestId, single `FormatDetectionResult`, `ClientIdentity`, normalized endpoint/source surface, `apiKeyId`, `disableRemoteMapping`) threaded from `ProxyRequestPort.handle` through `handleProxy`/`runProxyRequest`/`prepareProxyRequest`/`createProxyPort`. Detection precedence is explicit recognized helper/header, recognized client UA, body shape, earliest recognized bounded system/developer marker, endpoint; arbitrary UA is `rawUserAgent` only. All bounded markers scanned in order; conflicts noted without prompt text.

## Surface detection and normalization

| Stage | Behavior |
|---|---|
| Endpoint | `/v1/chat/completions` → `openai-chat`; `/v1/responses` → `openai-responses`; `/v1/messages` → `anthropic-messages`; `/v1/models` is catalog-only (see `src/proxy/translate/cross-surface.ts:detectClientFormat` + `src/proxy/types/surface.ts: Surface = openai-chat\|openai-responses\|anthropic-messages\|web-search\|images`) |
| Client format | single `FormatDetectionResult` via `src/proxy/normalize/detection.ts` — explicit recognized header/helper > recognized UA > body shape > earliest bounded marker > endpoint, with diagnostics (`ClientFormat`/`FormatDetectionResult`). Arbitrary UA recorded only as `rawUserAgent`; bounded-marker/body/endpoint/recognized-UA conflicts recorded without prompt text |
| Body parse | JSON-only request body with `RequestLimits.maxBodyBytes` (`OHMYOMOP_ROUTER_MAX_REQUEST_BODY_BYTES` 10MiB `runtime.ts:132`); `readBoundedJson` uses `ProxyIngressContext.requestId` (no second ID). Oversized or multi-document bodies fail before routing |
| Normalization | OpenAI Chat (`src/proxy/normalize/openai.ts:normalizeChatRequest`), OpenAI Responses (`normalizeResponsesRequest`), Anthropic Messages (`src/proxy/normalize/anthropic.ts:normalizeMessagesRequest`), Gemini (`src/proxy/upstream/gemini.ts:buildGeminiPayload`) converge on canonical ordered `ProxyRequest` with bounds `MAX_MODEL_LENGTH 256`, `MAX_MESSAGE_COUNT 2048` etc. Controls map to `ToolChoice`/`ResponseFormatConstraint`/`parallelToolCalls`; response-format/metadata preserved across compatible OpenAI-surface translations |

`prepareProxyRequest` receives the runtime `RequestLimits` created by bootstrap. It no longer owns a live-path fallback timeout object. Auth/body failures share the ingress `requestId`.

## Canonical event/outcome lifecycle

`src/proxy/types/stream.ts` terminal outcome: `completed | incomplete | failed | cancelled` carried on the final `message_stop`. `isTerminalEvent` recognizes only that final frame; all preceding lifecycle events are non-terminal. Terminal classification (`src/proxy/events/lifecycle.ts:classifyTerminal`) — `error` → failed; `length|content_filter|safety|empty|incomplete|cancelled|compaction` → incomplete; `completed|tool_call|pause_turn` → completed — preserved in each public surface's legal terminal fields.

`src/proxy/events/assembly.ts:foldResponseEvents` + `orderedResponseItems` is the single ordered fold: preserves arrival order across text, reasoning/signatures, tool start/delta/end, native start/delta/stop, server-tool result, context item, compaction, usage cache read/write, and terminal error/outcome. Provider tool call IDs/names validated — empty/missing name → typed `provider_protocol_error`, never `name:""`. Non-stream materializers fold canonical events (no independent text accumulator); direct `openai-responses↔anthropic-messages` registrations in `src/proxy/translate/cross-surface.ts`; `translateResponseDocument` projects the full folded document and rejects a nonrepresentable opaque/native/context item with typed capability error (never relabels/drops).…

## Normalizers

OpenAI Chat and Responses preserve supported reasoning, tool calls, multimodal parts (`images` via cursor/devin `supportsImages`), response items and cache metadata while applying bounded model/message/tool/image limits. Anthropic normalization handles `max_tokens`, thinking budgets, effort, cache controls, MCP fields and tool results. Gemini payload construction (`src/proxy/upstream/gemini.ts`) remaps roles, sanitizes function schemas and maps thinking configuration. All via `src/proxy/validation.ts` narrowing + `ToolCallLedger` + `repairToolCallRequest` (sole repair; ledger sanitizes IDs, de-duplicates, repairs orphans/missing results adjacent to owner).

All normalizers use shared narrowing and bounded JSON helpers. Image references pass SSRF classification; oversized data URLs and private/loopback/CGNAT destinations are rejected. `normalizeToolList` classifies structurally (OpenAI function → `function`, explicit Responses hosted → `hosted`, Anthropic/provider built-ins → `native`, unknown native → `opaque`); never fabricates a fake function schema for a non-function tool; preserves `strict`, custom/freeform format, raw upstream object, and native options.

## Pre-dispatch capability projection

Every payload builder projects each canonical tool/choice/parallel/format value to its upstream law — emitting the legal equivalent or throwing `ProtocolCodecError` with `capability_unsupported` before provider invocation. Same-surface custom/native objects stay structurally intact; identity is never inferred from a name. `src/proxy/routing/plan.ts` derives immutable `RequiredRouteCapabilities` (tools, hostedSearch, reasoning, image/pdf/video parts, responseFormat, required response projection) after preparation and filters candidates that cannot accept the request or project the requested surface before any account/network lease. `selectWireSurfaceAttempt` consumes the planned `resolveModelWireSurface` upstream surface and asserts only.

## Non-stream response path

```text
provider response
  → provider upstream dispatch (`providers/upstream/*: dispatchChatCompletions/dispatchResponses/dispatchAnthropic/dispatchGemini`)
  → canonical ResponseDocument/events (folded via `protocol/events/assembly.ts:foldResponseEvents`)
  → translateResponseDocument(targetSurface, document) — typed rejection for nonrepresentable items
  → requested JSON surface shape
```

Translation is capability-aware. Unsupported surface/protocol combinations return a typed capability error (`capability_unsupported`) before account/network/provider dispatch rather than silently dropping content.

## Stream path

```text
provider body
  → `transport/abort.ts:AbortCoordinator` + bounded reader
  → `transport/sse.ts:parseSseEvents` / provider upstream mapper (`transformOpenAIChatStream`, `transformAnthropicMessagesStream`, `transformGeminiGenerateContentStream` + `protocol/events/lifecycle.ts` gate: one start, valid tool names, one usage, one stop, no post-terminal)
  → canonical stream events (signatures, tool lifecycle, usage before stop)
  → `protocol/translate/stream.ts:translateSurfaceStream(surface)` — legal typed frames per surface
  → bounded Uint8Array SSE frames (`transport/sse.ts:STREAM_BOUNDS` per-frame + cumulative for Chat/Responses/Messages)
```

The first-body timer starts after response headers and is cleared only by the first non-empty body chunk. The idle watchdog (`transport/abort.ts`) runs only while waiting for the next upstream read. Cumulative stream bytes (`transport/sse.ts:STREAM_BOUNDS`) are checked before parsing. Public cancellation propagates to the upstream iterator/reader and owns the ingress abort listener (exactly-once close of provider/lease/network/capture/telemetry).

Lifecycle gate: one start before visible output, nonempty valid tool names, each started tool closed, at most one usage, one stop, no event after stop. Duplicate stop/post-terminal → `provider_protocol_error`. Fatal UTF-8/malformed framing → `ProviderAdapterError: provider_protocol_error`. `[DONE]` idempotent; synthesized only for otherwise unterminated stream; EOF without provider terminal is `stream_truncated`; provider errors produce a safe terminal surface error frame and no `[DONE]`. Outbound bounds apply to all surfaces.

## Shared policies

- `ToolCallLedger` repairs/allocates bounded tool-call ids and matches tool results.
- `preserveWireExtensions` is surface-specific and bounded.
- Diagnostics are capped, length-limited, and credential-redacted. `foldResponseEvents` validates tool names before folding.
- Retry decisions are constrained by semantic commit/terminal output and the single request deadline. Pre-commit failures are typed HTTP errors; post-commit failures are one legal typed stream terminal (never a second HTTP JSON body).
- Provider usage fields are normalized without fabricating cache-hit metrics (zero-usage fabrication and cached-token double-count removed).

## Reproduce translation behavior

Run the protocol unit/contract tests:

```sh
bun test src/proxy/events/assembly.test.ts \
  src/proxy/translate/cross-surface.test.ts \
  src/proxy/upstream/compatibility.test.ts \
  src/proxy/events/repair.test.ts \
  src/proxy/events/repair-stream.test.ts \
  --timeout 60000
```

For a live surface check, send the same semantic prompt to each public surface:

```sh
curl -sS http://127.0.0.1:12800/v1/chat/completions \
  -H "x-api-key: $PROXY_API_KEY" -H "content-type: application/json" \
  -d '{"model":"openai/gpt-4o-mini","messages":[{"role":"user","content":"Return one word: hello"}],"stream":false}' | jq .

curl -sS http://127.0.0.1:12800/v1/responses \
  -H "x-api-key: $PROXY_API_KEY" -H "content-type: application/json" \
  -d '{"model":"openai/gpt-4o-mini","input":"Return one word: hello","stream":false}' | jq .

curl -sS http://127.0.0.1:12800/v1/messages \
  -H "x-api-key: $PROXY_API_KEY" -H "content-type: application/json" \
  -d '{"model":"anthropic/claude-3-5-haiku","max_tokens":32,"messages":[{"role":"user","content":"Return one word: hello"}],"stream":false}' | jq .
```

The exact provider response shape differs by surface; the semantic output should remain equivalent. Provider credentials and model availability determine whether the live commands can complete. The deterministic tests do not require an upstream provider.

## 6. Stream & Lifecycle

`src/proxy/transport/abort.ts` owns connect, first-body, idle and total timers. The first-body timer starts only after response headers and is cleared by the first non-empty body byte. The idle watchdog is armed only around an upstream `reader.read()`; downstream mapper work and public backpressure do not consume idle time.

`src/proxy/transport/sse.ts` counts cumulative upstream bytes before parsing, enforces effective line/event/buffered/event-count bounds (64 KiB line, 64 KiB event, 512 KiB buffered, 100k events per `src/proxy/transport/sse.ts:STREAM_BOUNDS` — env overrides in `OHMYOMOP_ROUTER_MAX_STREAM_*` are clamped to those maxima; `src/runtime/runtime.ts` defines higher raw defaults but the effective caps are the `transport/sse.ts` clamps), cancels the reader on abort, and distinguishes caller abort, timeout, stream limit, and protocol failure. An EOF without a terminal event is `stream_truncated`.

`src/proxy/translate/stream.ts` is the public adapter. It gates pulls through `ReadableStream.desiredSize`, retains at most one pending frame, propagates cancellation to the canonical event iterator, and emits a sanitized surface-safe error frame without `[DONE]` after a provider failure. Outbound `STREAM_BOUNDS` byte limits apply to Chat, Responses, and Messages (frame-count only for Chat was removed); legal typed Responses frames are emitted per extended event (native/server/context/compaction).

Lifecycle gate (`src/proxy/events/lifecycle.ts` adjacent to `src/proxy/types/stream.ts`): enforced at every mapper and public projection — `mapSseStream`, NDJSON/protobuf adapters, `createSurfaceStream`. Invariants: one start before visible output, nonempty valid tool names, each started tool closed, at most one usage, one stop, no event after stop. Duplicate stop / post-terminal data → `provider_protocol_error`. Fatal UTF-8/decoder and malformed framing wrap as `UpstreamError` with `provider_protocol_error`. Upstream `[DONE]` is idempotent and synthesized only for an otherwise unterminated stream; EOF without a provider terminal is `stream_truncated`. `createSurfaceStream` cancels/aborts upstream exactly once on typed iterator failure or reader cancella…

## Provider catalog

---
_Merged from ARCHITECTURE.md + ROUTING.md + TRANSLATION.md_

---


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
  src/proxy/translate/surface.test.ts \
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

## 4. Deployment

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

---


> Merged: Providers + Auth Refresh + Proxy Pool + WireGuard Pool + Cache Hit — full provider surface.

```mermaid
sequenceDiagram
  Client->>Proxy: POST /v1/chat/completions
  Proxy->>Registry: resolve model
  Proxy->>Quota: check/fetch
  Proxy->>Provider: dispatch
  Provider-->>Proxy: stream/events
```

```text
ASCII: Registry(47 defs) -> Discovery(fetch-models/cursor/devin) -> Auth Refresh(lease/CAS) -> Quota -> Proxy Pool(SOCKS) / WireGuard -> Cache Plan(prefix) -> Upstream
```

## 1. Registry & Catalog

## Access classification

Provider definitions are owned by `src/providers/model-catalog.ts`, `src/providers/oauth-provider/provider-definitions.ts`, `src/providers/api-key/*`, `src/providers/web-search/*`, and `src/providers/api-key/custom-provider.ts`.

The current built-in registry contains 47 definitions (authoritative `builtinProviderDefinitions()` in `src/providers/registry.ts` + `OAUTH_PROVIDER_DEFINITIONS` in `src/providers/oauth-provider/provider-definitions.ts`):

- **10 OAuth:** `antigravity` (gemini), `codex` (openai), `claude` (anthropic), `zaicp` (openai, oauth+api_key), `kimi-code` (openai), `github` (openai), `cursor` (openai), `devin` (openai), `cline` (openai, oauth+api_key), `cline-pass` (openai, oauth+api_key).
- **37 API-key definitions:** `openai`, `anthropic`, `gemini`, `openrouter`, `groq`, `alibaba`, `fireworks`, `deepseek`, `mistral`, `siliconflow`, `cerebras`, `nvidia`, `xiaomipg`, `xiaomitp`, `blackboxai`, `ollama`, `cloudflare`, `cb`, `cbcn`, `opencodeft`, `opencodezen`, `opencodego`, `commandcode`, `qoder`, `agentrouter`, `exa`, `devin-search`, `perplexity`, `parallel`, `inferhub`, `gmi`, `zai`, `alibabacp`, `hermes`, `bai`, `tokenharbor`, `aihubmix` (per `src/providers/registry.ts` `API_KEY_PROVIDER_DEFINITIONS`) assembled by `src/providers/default-registry.ts` (display names: CodeBuddy/`cb`, CodeBuddy CN/`cbcn`, GMI Cloud/`gmi`, Alibaba Coding Plan/`alibabacp`, Nous Research/`hermes`).
- **Custom:** database-defined providers projected by `customProviderDefinition`; the count is runtime/database dependent.

The authoritative list is `builtinProviderDefinitions()` and its registry test. Do not duplicate a provider list in application code or configuration documentation when the definition source changes.

## Registry and adapter ownership

`src/providers/registry.ts` contains registration and target-resolution mechanics (`providerAccessFor`, `builtinProviderDefinitions`). `src/providers/default-registry.ts` composes the eager built-in set: 41 eager adapters + 5 lazy (`codex`, `claude`, `antigravity`, `cursor`, `devin` via `loadOptionalProvider`) → `registry.size 46` (vs 47 definitions; `kimi-code` has no eager adapter, `zai` duplicated via `new ZaiProvider("zaicp")` — intentional divergence verified in `src/providers/provider-registry.test.ts`: `definitions.length 47, oauth 10, registry.size 46`). Each adapter owns its provider upstream dispatch, credential interpretation, protocol capabilities, model catalog, and error normalization. OAuth drivers are resolved through `src/auth/driver-registry.ts`.

Custom providers use the same canonical protocol surfaces but obtain endpoint/auth/profile data from PostgreSQL. There is no central project-owned codec or generic provider transport module.

## Model catalog and discovery

`src/providers/model-catalog.ts` merges static and discovered models by id. The merge keeps the largest known input context and retains a static fallback when discovery is unavailable.

Discovery: `src/providers/fetch-models.ts` (openai-compatible tolerant `/models` parsing + generic five-minute `refreshGenericProviderCatalog` per `src/runtime/runtime.ts` bounded limits) + OAuth inline discovery:
- `src/providers/oauth-provider/cursor.ts:GetUsableModels` + `src/providers/oauth-provider/cursor/agent_pb.ts` — HTTP/2 `POST https://api2.cursor.sh/agent.v1.AgentService/GetUsableModels` with `Authorization: Bearer <token>` + `x-cursor-client-version: cli-2026.02.13-41ac335` (`Run` uses `cli-2026.07.23-e383d2b`), Connect unary framing (5-byte flag+length, gzip 0x01 fallback), `GetUsableModelsRequest/Response` protobuf, static fallback 7 models (`default`, `claude-4.5/4.6-opus/sonnet`, `composer-2.5/fast`) with 200k/64k context.
- `src/providers/oauth-provider/devin.ts:GetCliModelConfigs` + `src/providers/oauth-provider/devin/proto-gen/exa/api_server_pb/api_server_pb.ts` + `src/providers/oauth-provider/devin/proto-gen/exa/codeium_common_pb/codeium_common_pb.ts` — `POST https://server.codeium.com/exa.api_server_pb.ApiServerService/GetCliModelConfigs` with `Authorization: Bearer <token>` (`normalizeDevinSessionToken`), `Metadata{ideName:WINDSURF}` protobuf, gzip + Connect 5-byte frame handling, maps `ClientModelConfig{label, modelUid, modelOrAlias, maxTokens, supportsImages, disabled}` → `capabilitiesOf({surfaces:[openai-responses], streaming, reasoning, images})`. Static fallback `swe-1-6-slow` 200k/64k.
- `src/providers/fetch-models.ts` still owns generic openai-compatible `/models` tolerant parsing; codex/antigravity failover + `lastGoodEndpoint` per-credential 5m cache via `fetchCodexModels`/`fetchAntigravityDiscoveryModels`. `@bufbuild/protobuf` `create/fromBinary/toBinary` is imported directly in `cursor.ts`/`devin.ts` (no `src/proto` barrel).
- Generic OpenAI-compatible gateways:
  - `src/providers/api-key/bai.ts` — `https://api.b.ai/v1` (B.AI) multi-surface `openai-chat` + `openai-responses` + `anthropic-messages`, auth `Bearer sk-...` or `x-api-key`, discovery `GET /v1/models`, dispatch per `target.surface` to `dispatchChatCompletions` / `dispatchResponses` / `dispatchAnthropic` via `src/proxy/upstream/{openai,anthropic}.ts` (https://docs.b.ai/llmservice/api/).
  - `src/providers/api-key/tokenharbor.ts` — `https://tokenharbor.ai/v1` (TokenHarbor) `thk_live_...`, surfaces `openai-chat` + `openai-responses`, discovery `/v1/models` (https://tokenharbor.ai/docs/getting-started/quickstart).
  - `src/providers/api-key/aihubmix.ts` — `https://aihubmix.com/v1` (AiHubMix) `sk-...`, surfaces `openai-chat` + `openai-responses`, discovery legacy `GET /v1/models` tolerant + fallback `GET https://aihubmix.com/api/v1/models` (`model_id` mapping) (https://docs.aihubmix.com/en/api/Models-API).

Discovery is linked to model fetching for generic API-key providers; it is not a required registry-startup network call. When `discoverModels` receives empty credential it returns `null` and the static fallback model remains visible.

## OAuth identity boundary

OAuth adapters retain reference-client identities on upstream requests. Local `OHMYOMOP_ROUTER_VERSION` is used only for local health/version surfaces, dashboard identity and logs. Antigravity (`antigravity/hub/<version>`), Codex (`codex-cli/<version>` + `chatgpt-account-id`), Claude Code (`claude-code` + betas), Cursor (`x-cursor-client-version` + HTTP/2), Devin (`devin-session-token$` + `WINDSURF` Metadata) each own their required user-agent/header behavior in their adapter module (`src/providers/oauth-provider/*`).

## Protocol ownership

Provider adapters receive canonical request types and return canonical response/stream events. Protocol normalization and surface projection remain in `src/proxy/*`; provider-specific upstream dispatch stays under `src/proxy/upstream/*` (`openai.ts: dispatchChatCompletions/dispatchResponses + transformOpenAIChatStream/ResponsesStream`, `anthropic.ts: dispatchAnthropic + transformAnthropicMessagesStream`, `gemini.ts: dispatchGemini + transformGeminiGenerateContentStream`, `adapter.ts`, `compatibility.ts`, `protobuf.ts`).

## Operational guidance

1. Add a built-in provider through its owning adapter and provider definition.
2. Add OAuth only through an `AuthDriver` registration.
3. Keep static fallback models when discovery fails.
4. Preserve sanitized provider errors and route scope so retry policy remains correct.
5. Run `bun run version:check`, `bunx tsc --noEmit`, provider tests and `bun run scripts/dev/verify.ts` after registry changes.

## Reproduce provider registry and discovery

Run the deterministic registry/catalog tests:

```sh
bun test src/providers --timeout 60000
# or granular:
bun test src/providers/provider-registry.test.ts src/providers/model-catalog.test.ts --timeout 60000
```

The tests verify built-in definitions (`47`), access classification (`10 oauth` + `37 api_key`), eager registry size (`46` = 41 eager +5 lazy; `kimi-code` has no eager adapter), model merge behavior and tolerant discovery parsing without requiring provider credentials. `glob src/providers/**/*.test.ts` shows 11 provider test files.

With a console session, inspect the runtime registry projection:

```sh
curl -sS http://127.0.0.1:12800/console/api/providers \
  -H "Cookie: ohmyomop_router_console=$CONSOLE_SESSION" | jq .
curl -sS http://127.0.0.1:12800/v1/models \
  -H "x-api-key: $PROXY_API_KEY" | jq .
```

The first response shows provider definitions/configuration state; the second shows models visible to the API key. Live discovery only occurs when the selected provider/account path requests it (credential non-empty), so a static fallback can appear when the upstream catalog is unavailable or credential empty (`discoverModels` returns `null`).

## 2. Auth Refresh & Quota

## Two background concerns

| Component | Source | Responsibility |
|---|---|---|
| OAuth refresh pool | `src/auth/refresher.ts` | Fresh access tokens, single-flight refresh, leases, retry state |
| Quota worker | `src/auth/refresher.ts (QuotaRefreshWorker) + src/bootstrap/quota.ts` | Provider quota/limit refresh into `provider_account_quota` |

Both use PostgreSQL-backed account state and the shared coordination boundary. Redis is used when configured; local bounded coordination is the fallback.

## OAuth lifecycle

```text
provider account
  → read encrypted credential
  → check expiry with skew
  → single-flight refresh per account
  → acquire distributed/local refresh lease
  → provider token request
  → fingerprint/CAS write
  → return TokenLease
  → release exactly once
```

A refresh winner persists the new token only when the expected generation/fingerprint still matches. A losing process rereads the current account token instead of overwriting it. Concurrent requests for one account share the same in-flight refresh promise.

Refresh failures record sanitized error kind, retry time and failure count. The account remains in a retrying state until refresh succeeds or operator action changes its credential.

## Reactive refresh

During request execution, an OAuth `401`/`403` classified as authentication or authorization failure can schedule a non-blocking `forceRefresh(accountId)`. The current request still obeys its total deadline and retry policy; refresh does not create an unbounded retry loop.

## Quota refresh

`fetchProviderQuota` dispatches by provider id via `src/providers/quota-fetch/fetch.ts:QUOTA_FETCHERS` (12 entries, `unsupportedQuota` fallback) and `src/bootstrap/quota.ts:supportsProvider` gating in `QuotaRefreshWorker`:

- **Quota dispatch namespace** (`QUOTA_FETCHERS` keys in `src/providers/quota-fetch/fetch.ts:15`): `antigravity`, `claude` (short, not `claude-code`), `cline`, `cline-pass`, `codex`, `ollama`, `zai`, `zaicp` (both map to `fetchZaiQuota`; `zaicp` normalizes source to `"zaicp"`), `kimi-code`, `github` (short, not `github-copilot`, maps to `fetchGithubCopilotQuota`), `cursor`, `devin`. Verify via `grep -rn QUOTA_FETCHERS src/providers/quota-fetch/fetch.ts`.
- **Auth-driver namespace** (`src/auth/driver-registry.ts:createAuthDriverRegistry`, 10 drivers): `antigravity`, `claude-code` (Anthropic OAuth, not `claude`), `cline`, `cline-pass`, `codex`, `zai-coding-plan` (not `zaicp`/`zai`), `kimi-code`, `github-copilot` (not `github`), `cursor`, `devin`. Provider definitions in `src/providers/oauth-provider/provider-definitions.ts` use the short ids `claude`/`zaicp`/`github` (10 entries). The two namespaces are deliberately distinct: quota fetch and provider catalog use short ids, driver registry lookup uses namespaced ids (`claude-code`, `zai-coding-plan`, `github-copilot`). Do not conflate them.
- **Quota worker gating** (`src/bootstrap/quota.ts:245`): `supportsProvider` Set 11 — `antigravity`, `claude-code`, `cline`, `codex`, `ollama`, `zai`, `zai-coding-plan`, `kimi-code`, `github-copilot`, `cursor`, `devin`. Note `zai` is included though no driver exists for plain `zai`, and `ollama` has a quota fetcher but no OAuth driver; `zai` + `zai-coding-plan` are both accepted so either dispatch id passes the gate. Verify via `read src/bootstrap/quota.ts:240-250`.

The quota worker (`src/auth/refresher.ts (QuotaRefreshWorker) + src/bootstrap/quota.ts` — bounded periodic, `supportsProvider` filter) performs bounded work and the console exposes manual `POST /console/api/accounts/:id/quota/refresh`. Quota and health/cooldown state affect account eligibility during route planning. On 404 `fetchCursorQuota` returns `{source:"cursor", plan:null, windows:[], error:"No Cursor plan"}` not empty; `fetchDevinQuota` uses Windsurf `SeatManagementService/GetUserStatus` (credit windows + daily/weekly remaining) else `unsupportedQuota` fallback.

## Observability and operations

Monitor account health, `retryAt`, refresh state, refresh failure count and quota timestamps in the console. Relevant runtime evidence is available through overhead phases and telemetry; credential values and bearer tokens are never written to telemetry.

Operational checklist:

- Keep an OAuth refresh token persisted for providers that require refresh.
- Do not edit encrypted credential columns manually.
- Investigate repeated `authentication_failed` events together with account health and refresh retry state.
- Verify PostgreSQL readiness before diagnosing provider refresh failures.

## Reproduce auth/cache behavior

The API-key cache behavior is deterministic and does not require a provider:

```sh
bun test src/console/services/api-keys.test.ts \
  src/proxy/routing/routing-reliability.test.ts \
  --timeout 60000
```

The tests cover active records, revoked records after cache expiry, cache TTL, repository snapshot invalidation, and the rule that non-retryable errors do not invoke a second route candidate.

For a live OAuth flow:

```sh
curl -i http://127.0.0.1:12800/console/api/providers \
  -H "Cookie: ohmyomop_router_console=$CONSOLE_SESSION"
curl -i -X POST http://127.0.0.1:12800/console/api/accounts/<ACCOUNT_ID>/quota/refresh \
  -H "Cookie: ohmyomop_router_console=$CONSOLE_SESSION"
```

The OAuth start/callback flow requires a provider account and its real authorization endpoint. Do not paste access or refresh tokens into shell history or documentation.

## 3. Proxy Pool

## Ownership

| Concern | Source |
|---|---|
| PostgreSQL proxy configuration | `src/persistence/repositories/proxies.ts` and console proxy services |
| Network selection | `src/proxy/request/prepare.ts`, `attempt.ts`, `executor.ts` |
| Transport | `src/proxy/transport/fetch.ts`, `proxy-fetchers.ts`, `network.ts` |
| Console UI | dashboard proxy request feature |

Supported outbound protocols are HTTP, HTTPS and SOCKS5 (`socks-proxy-agent` with keepAlive). Proxy records carry endpoint, active state, priority/weight, concurrency and sanitized health/test state.

## Transport behavior

```text
NetworkSelector
  → direct upstream or selected proxy
  → HTTP/HTTPS fetcher, SOCKS5 agent, or relay fetcher
  → AbortCoordinator signal
  → upstream executor and provider protocol
```

SOCKS5 agents use keep-alive connections and a bounded process cache (`src/proxy/transport/network.ts` evict oldest). Every proxy URL is validated via `src/proxy/transport/network.ts` before use; credentials are never copied into telemetry messages.

## Health and capacity

The console can create/update/delete, enable/disable, test and bulk-manage proxies. Health state is sanitized and includes test timestamps/latency where available. `maxConcurrency` limits per-proxy in-flight work; weight/priority participate in candidate ordering.

## Failover

Failover is owned by request routing, not by the low-level fetcher. A proxy/network error is retryable only when its mapped error is retryable, the route has another candidate, the total request deadline remains, and semantic output has not committed. A non-retryable error releases its lease and propagates immediately.

The stream commit gate prevents retry after semantic output (`text_delta`, thinking, tool output or terminal event) has reached the client.

## Operations

1. Keep at least two active proxies when failover is required.
2. Set concurrency based on provider and proxy capacity, not only socket capacity.
3. Run proxy tests after changing endpoint or credentials.
4. Monitor health and `/health/overhead` upstream phases.
5. Keep the SOCKS cache bounded; do not introduce an unbounded per-request agent map.

## Reproduce proxy selection and failover

With a console session, list and test configured proxies. The proven endpoints are `POST /console/api/proxies/test` (ad-hoc) and `POST /console/api/proxies/:id/test` (stored or override) per `src/console/api.ts:442-454` and `src/console/services/proxy-pool.ts:83-115`:

```sh
curl -sS http://127.0.0.1:12800/console/api/proxies \
  -H "Cookie: ohmyomop_router_console=$CONSOLE_SESSION" | jq .

# Ad-hoc test — always requires body { protocol?, host, port } (src/console/services/proxy-pool.ts:83-97)
curl -sS -X POST http://127.0.0.1:12800/console/api/proxies/test \
  -H "Cookie: ohmyomop_router_console=$CONSOLE_SESSION" \
  -H "Content-Type: application/json" \
  -d '{"protocol":"http","host":"1.2.3.4","port":8080}' | jq .

# Stored-config test — empty object uses the saved endpoint via testOne(id) (src/console/services/proxy-pool.ts:98-115)
curl -sS -X POST http://127.0.0.1:12800/console/api/proxies/<PROXY_ID>/test \
  -H "Cookie: ohmyomop_router_console=$CONSOLE_SESSION" \
  -H "Content-Type: application/json" -d '{}' | jq .

# Per-ID body-required variant — when only proxies.test is wired, the per-ID route
# falls back to test(body) and requires body !== undefined (src/console/api.ts:451-453);
# also usable as an override to test a different host/port against the same proxy id
curl -sS -X POST http://127.0.0.1:12800/console/api/proxies/<PROXY_ID>/test \
  -H "Cookie: ohmyomop_router_console=$CONSOLE_SESSION" \
  -H "Content-Type: application/json" \
  -d '{"protocol":"socks5","host":"127.0.0.1","port":11080}' | jq .
```

For a deterministic transport smoke test:

```sh
bunx tsc --noEmit
bun test src/proxy/transport src/proxy/routing --timeout 60000
```

To observe real failover, configure two active proxies that can reach the same provider, make the first unavailable, and send a request before semantic output commits. The request may select the second candidate only when the mapped error is retryable and the single total deadline still has time. After the first semantic stream event, retry is intentionally disabled.

## 4. WireGuard Pool

Oh My Omop - Router's WireGuard pool is an optional Go sidecar. It uses userspace WireGuard and gVisor netstack, exposes one local SOCKS5 endpoint per tunnel, and registers those endpoints as PostgreSQL-backed proxy records through the console API. Oh My Omop - Router itself only sees normal proxy records and does not manage kernel WireGuard devices.

## Generate WARP configurations

`scripts/warp-generate.ts` uses Bun and `@noble/curves` X25519 instead of a platform `wg` binary. It registers public keys through the Cloudflare WARP endpoint (`WARP_API_URL https://api.cloudflareclient.com/v0a737/reg`, `WARP_MTU 1280`) and writes compatible INI files:

```sh
bun run warp:generate --count 1
bun run warp:generate --count 5 --out ./pool
bun run warp:generate --count 50 --out ./pool
```

Generated files use standard `[Interface]`/`[Peer]` INI sections. Relevant overrides are `WARP_API_URL`, `WARP_MTU`, `WARP_DNS`, `WARP_ALLOWED_IPS`, `WARP_DEVICE_TYPE`, and `WARP_LOCALE`.

## WireGuard sidecar — proven binary entrypoint

`vendor/wireproxy` is a library package (`package wireproxy`, `module github.com/windtf/wireproxy`) — it has no `main` and `go run ./vendor/wireproxy` is not a valid entrypoint. The proven entrypoint is the `wireproxy` binary built from `vendor/wireproxy/cmd/wireproxy`:

```sh
# from repository root
make -C vendor/wireproxy
# or
go build -trimpath -ldflags "-s -w" -o ./bin/wireproxy ./vendor/wireproxy/cmd/wireproxy
# Windows
go build -trimpath -ldflags "-s -w" -o ./bin/wireproxy.exe ./vendor/wireproxy/cmd/wireproxy
```

Runtime usage (verified in `src/console/api.ts:51-53,102-108,525-533,586`):

```sh
# validate a config before import
./bin/wireproxy -n -c ./data/wireguard/wg-us-01-11080.conf

# run a single tunnel (one SOCKS5 listener per tunnel)
./bin/wireproxy -c ./data/wireguard/wg-us-01-11080.conf
```

In production Oh My Omop - Router spawns one `wireproxy` process per tunnel via `Bun.spawn([wireproxyBin, "-c", configPath])` and persists the mapping in `wireguard_tunnels` (`socks5://127.0.0.1:11080+N`, `src/console/api.ts:47-49,562-616`). The `[Socks5] BindAddress = 127.0.0.1:<port>` section is appended automatically if missing. Each tunnel forwards supported AmneziaWG fields (`Jc`/`Jmin`/`Jmax`/`S1`/`S2`/`H1`..`H4` per `vendor/wireproxy/config.go`) when present and applies configured per-proxy capacity.

## Environment ownership

| Variable | Owner | Default / location |
|---|---|---|
| `WIREPROXY_BIN` | Bun proxy (`src/console/api.ts` reads `Bun.env.WIREPROXY_BIN`, fallback `./bin/wireproxy.exe`) | `.env.example:22` `WIREPROXY_BIN=./bin/wireproxy.exe` |
| `WIREGUARD_CONFIG_DIR` | Bun proxy — directory where `POST /console/api/wireguard/import` writes `*.conf` files | `.env.example:23` `./data/wireguard` |
| `WIREGUARD_START_PORT` | Bun proxy — first `socks5://127.0.0.1:<port>` to allocate, incremented per import (`src/console/api.ts:566-570`) | `.env.example:24` `11080` |
| `GOMEMLIMIT` / `GOGC` | Go runtime for the `wireproxy` sidecar processes only (`GOMEMLIMIT=800MiB GOGC=50` for ~50 tunnels) | `vendor/wireproxy/TUNING_1GB.md` — not Bun proxy settings |
| `WARP_API_URL` / `WARP_MTU` etc. | `scripts/warp-generate.ts` only | `WARP_API_URL=https://api.cloudflareclient.com/v0a737/reg` `WARP_MTU=1280` |
| `OHMYOMOP_ROUTER_URL` / `PROXY_API_KEY` pool registration | Not used by the proven console path — `vendor/wireproxy/pool.go:PoolManager` fields exist in library code but the active registration path is server-side `POST /console/api/wireguard/import` → `proxies` table (`src/console/api.ts:562-616`); do not set `OHMYOMOP_ROUTER_URL`/`PROXY_API_KEY` for pool startup in this mode | Removed from pool instructions |

`.env.example` values for `WIREPROXY_BIN` / `WIREGUARD_CONFIG_DIR` / `WIREGUARD_START_PORT` are consumed by the Bun process; they are not wireproxy INI directives. `GOMEMLIMIT`/`GOGC`/`WARP_*` are not required by the Bun proxy.

## Console integration

The dashboard Proxy Pool page and `GET /console/api/wireguard/status` are the source of truth after import. The active console endpoints (verified in `src/console/api.ts:456-616` and `src/console/services/proxy-pool.ts:98-115`) are:

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/console/api/wireguard/import` | Persist INI (`{ name?, content, port? }` → `content` must contain `[Interface]`/`[Peer]` + `PrivateKey`/`PublicKey`), write `WIREGUARD_CONFIG_DIR/<name>-<port>.conf` with `wireguardConfigWithSocks`, validate via `wireproxy -n -c`, `Bun.spawn([wireproxyBin, "-c", ...])`, create `socks5://127.0.0.1:<port>` proxy record and `wireguard_tunnels` row |
| `POST` | `/console/api/wireguard/validate` | Validate INI without persisting (`{ content }` → `wireproxy -n -c` temp file) |
| `POST` | `/console/api/wireguard/warp/create` | Generate one WARP INI via `bun run scripts/warp-generate.ts` |
| `GET` | `/console/api/wireguard/status` | `{ enabled, running, total, tunnels[] }` — `tunnels` joined from `wireguard_tunnels` + `wireguardProcesses` + `proxies.active` |
| `POST` | `/console/api/wireguard/toggle` | `{ enabled: boolean }` → flips `wireguard_pool_settings.enabled`, kills or re-spawns tunnel processes, updates `proxies.active` |
| `POST` | `/console/api/proxies/:id/test` | Health for a single tunnel (uses stored endpoint via `testOne`, see `docs/PROXY_POOL.md`) |
| `GET` | `/console/api/proxies` | List all proxy records including WireGuard SOCKS endpoints |

After registration, test each endpoint from the dashboard or `POST /console/api/proxies/:id/test` before enabling it for routing. Proxy health, weight and concurrency remain governed by the normal proxy pool path (`src/persistence/repositories/proxies.ts`, `src/proxy/request/*`, `src/proxy/transport/fetch.ts`). The 50-tunnel memory target is an operational tuning target, not an API guarantee — measure RSS and provider traffic on the target host before scaling.

## Security

Keep the registration console session out of shell history where practical. Bind local SOCKS listeners to `127.0.0.1` unless deliberate network exposure is required (default `BindAddress = 127.0.0.1:<port>`). Treat imported INI files as credentials and do not commit them. `wireguard_tunnels.config_path` stores the on-disk path (`WIREGUARD_CONFIG_DIR`) — restrict filesystem permissions accordingly.

## Reproduce a small pool (via console API)

Generate one configuration:

```sh
bun run warp:generate --count 1 --out ./pool
```

Validate it without persisting:

```sh
curl -sS -X POST http://127.0.0.1:12800/console/api/wireguard/validate \
  -H "Cookie: ohmyomop_router_console=$CONSOLE_SESSION" \
  -H "Content-Type: application/json" \
  -d "{\"content\": $(jq -Rs . < ./pool/warp-01.conf)}" | jq .
```

Import it — the server validates with `wireproxy -n -c`, spawns `wireproxy -c`, and registers `socks5://127.0.0.1:<port>`:

```sh
curl -sS -X POST http://127.0.0.1:12800/console/api/wireguard/import \
  -H "Cookie: ohmyomop_router_console=$CONSOLE_SESSION" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"wg-test-01\",\"content\": $(jq -Rs . < ./pool/warp-01.conf)}" | jq .

curl -sS http://127.0.0.1:12800/console/api/wireguard/status \
  -H "Cookie: ohmyomop_router_console=$CONSOLE_SESSION" | jq .

curl -sS http://127.0.0.1:12800/console/api/proxies \
  -H "Cookie: ohmyomop_router_console=$CONSOLE_SESSION" | jq .
```

Expected observation: `GET /console/api/wireguard/status` reports `running: 1` and `GET /console/api/proxies` contains a `socks5://127.0.0.1:11080` record. Test it before enabling for routing:

```sh
curl -sS -X POST http://127.0.0.1:12800/console/api/proxies/<PROXY_ID>/test \
  -H "Cookie: ohmyomop_router_console=$CONSOLE_SESSION" \
  -H "Content-Type: application/json" -d '{}' | jq .
```

This requires a built wireproxy binary (`make -C vendor/wireproxy` → `./bin/wireproxy`), network access to the WARP registration endpoint for generation, and a running Oh My Omop - Router instance with PostgreSQL. Use a manually prepared INI when WARP registration is unavailable. The binary validates and runs on Linux/macOS/Windows; the `WIREPROXY_BIN=./bin/wireproxy.exe` default in `.env.example` reflects the Windows path — use `./bin/wireproxy` on Unix.

WireGuard tunnel lifecycle is owned by `vendor/wireproxy` (library) as spawned by the console API; Oh My Omop - Router only governs proxy health/selection. For capacity tuning see `vendor/wireproxy/TUNING_1GB.md` (`GOMEMLIMIT=800MiB GOGC=50`, `MaxConcurrency=20`, staggered `Up()` 100 ms, global gVisor `sync.Pool`).

## 5. Cache Hit

Oh My Omop - Router does not implement a provider cache. It computes a stable prefix, attaches provider-supported cache metadata, and forwards the request. Provider usage is the only evidence of a provider-side hit or write.

## Cache path

```text
public request
  → protocol normalization (src/proxy/*)
  → router/cache-plan.ts  (pure classification: sections, stability, FNV-1a fingerprint)
  → router/route.ts re-export + router/request/prepare.ts integration (shouldBuildCachePlan threshold, buildCachePlan/applyCachePlan with affinity)
  → compression/filter policy (fused)
  → provider payload builder (src/providers/* adapters map plan → native cache markers)
  → provider-owned cache
```

`src/proxy/translate/request.ts (buildCachePlan/applyCachePlan)` is the single owner of the cache plan: `CacheSectionKind` (`system`/`developer`/`tools`/`static_context`/`stable_history`/`dynamic`), `shouldBuildCachePlan(request)` (threshold `CACHE_PLAN_MESSAGE_THRESHOLD` 3 — builds only if `tools.length>0` or `messages.length>3`), `buildCachePlan`, `applyCachePlan` (FNV-1a 64-bit `prefixFingerprint` + `request.model` + `request.sourceSurface` + `affinityKey` → `cacheKey`/`prompt_cache_key`), `looksStableText`/`stablePrefixText` (rejects timestamps, UUIDs, PEM blocks), and breakpoint helpers (`findCacheBreakpoint`, `applyOpenAIChatCacheBreakpoint`, `applyOpenAIResponsesCacheBreakpoint`, `supportsOpenAIPromptBreakpoints`). `src/proxy/routing/plan.ts` re-exports the plan helpers; `src/proxy/request/prepare.ts:534` wires `applyCachePlan(buildCachePlan(...), affinityKey)` into the single `messages.map` fused compression pass. Provider adapters translate the plan to native markers; there is no toggle, config row, or persisted prefix anywhere in this module.

The path is shared by Chat Completions, Responses and Anthropic Messages. Cache metadata is request/route metadata; it is not a local boolean claiming a hit. Verify via `grep -rn "buildCachePlan\|shouldBuildCachePlan" src/proxy/routing/`.

## Stable prefix rules

Stable system/developer content, stable history and stable tool definitions can form the prefix. Volatile timestamps, UUIDs, request IDs and PEM-like content shorten or invalidate it. Keep stable content first and put the changing user request at the end.

Tool names, order, descriptions and schemas must remain byte-stable. Model, surface and affinity namespace are part of the cache identity; changing them intentionally creates a different namespace.

## Provider-specific behavior

- Anthropic receives `cache_control` on supported stable blocks.
- OpenAI Chat and Responses preserve canonical stable-prefix metadata and provider-supported cache extensions (`prompt_cache_key` always preserved; explicit `cache_control`/`prompt_cache` markers stripped/restored via `stripOpenAIPromptCacheMetadata`).
- Other providers may ignore cache metadata; the request remains valid.

## Evidence

Inspect provider usage fields rather than Oh My Omop - Router-only telemetry:

| Surface | Typical evidence |
|---|---|
| OpenAI Chat | `usage.prompt_tokens_details.cached_tokens` |
| OpenAI Responses | `usage.input_tokens_details.cached_tokens` |
| Anthropic Messages | `usage.cache_read_input_tokens` |
| Cache creation, when exposed | provider-specific write/creation token field |

Provider responses may omit write metrics or use different accounting. Do not infer a write from a successful request or fabricate a cache count in telemetry.

## Operational checklist

1. Keep the same model, surface and affinity namespace.
2. Keep the stable prefix and tool definitions unchanged.
3. Remove timestamps/request IDs from prompt content.
4. Repeat the request only after the first request succeeds.
5. Compare provider usage fields across the repeated requests.

Ownership: `src/proxy/translate/request.ts (buildCachePlan/applyCachePlan)` (classification + fingerprint), `src/proxy/routing/plan.ts` (re-export), `src/proxy/request/prepare.ts` (affinity-aware integration), provider adapters in `src/providers/*` + `src/proxy/normalize/openai.ts`/`openai-payload.ts`/`src/proxy/normalize/anthropic.ts` (native marker mapping). `src/persistence/telemetry/pipeline.ts` only records safe metadata — it does not implement or claim cache hits. Verify via `read src/proxy/translate/request.ts (buildCachePlan/applyCachePlan):1-60` and `grep -rn "applyCachePlan" src/proxy/request/prepare.ts`.

## Reproduce a cache observation

Use a stable prompt and the same model, surface and affinity header twice:

```sh
payload='{"model":"openai/gpt-4o-mini","messages":[{"role":"system","content":"You are a cache test assistant. Keep this instruction unchanged."},{"role":"user","content":"Changing question"}],"stream":false}'

curl -sS http://127.0.0.1:12800/v1/chat/completions \
  -H "x-api-key: $PROXY_API_KEY" \
  -H "x-ohmyomop-router-affinity: cache-repro-1" \
  -H "content-type: application/json" \
  -d "$payload" | jq '.usage'

curl -sS http://127.0.0.1:12800/v1/chat/completions \
  -H "x-api-key: $PROXY_API_KEY" \
  -H "x-ohmyomop-router-affinity: cache-repro-1" \
  -H "content-type: application/json" \
  -d "$payload" | jq '.usage'
```

Compare the provider-specific cached-token fields listed above. A zero value is a valid observation: the selected provider/model may not report a cache read. Repeat the same experiment with `/v1/responses` or `/v1/messages` and compare the corresponding usage field. This requires an upstream that supports and reports prompt caching; Oh My Omop - Router cannot force or simulate it.

---
_Merged from PROVIDERS.md + AUTH_REFRESH.md + PROXY_POOL.md + WIREGUARD_POOL.md + CACHE_HIT.md_

---


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
  As of this doc, `find` reports ~63 `src/**/*.test.ts` + 2 `test/*.test.ts` + ~32 `dashboard/test` files; use the commands above as ground truth rather than the prose number.

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

---

## 8. API (summary)

```mermaid
sequenceDiagram
  participant C as Client
  participant G as Guard (auth/body)
  participant P as Proxy (/v1/*)
  participant R as Router/Plan
  participant U as Upstream Provider
  participant S as Stream/SSE
  C->>G: POST /v1/chat/completions + Bearer/x-api-key
  G->>P: ProxyIngressContext (requestId)
  P->>R: normalize + RequiredRouteCapabilities
  R->>U: adapter.call (remaining deadline)
  alt pre-commit failure
    U-->>C: {error:{type:error,code,request_id}} + x-request-id
  else post-commit
    U->>S: canonical events -> surface frames
    S-->>C: text/event-stream + [DONE]
  end
```

```text
ASCII: Client --Bearer/x-api-key--> Guard(computeBodyLimit/readBoundedJson) --ProxyIngressContext(requestId)--> P(handleProxy) --normalize--> Plan --lease--> Provider --SSE/AbortCoordinator--> Stream(lifecycle gate) --surface--> Client
       Error path: pre-commit -> {error:{code,request_id}} + x-request-id | post-commit -> typed stream terminal (no second JSON)
```

| Decision | Table |
|---|---|
| Auth | `Authorization: Bearer` OR `x-api-key` → `ProxyIngressContext.apiKeyId` |
| Body limit | `OHMYOMOP_ROUTER_MAX_REQUEST_BODY_BYTES` 10MiB [64KiB-64MiB] dual-enforced (guard + RequestLimits) |
| Stream bounds | 64KiB line / 64KiB event / 512KiB buffered / 100k events + cumulative 10MiB (`STREAM_BOUNDS`) |

## Public health and metrics

| Method | Path | Authentication | Purpose |
|---|---|---|---|
| `GET` | `/health` | none | Liveness, version and security headers |
| `GET` | `/health/ready` | none | PostgreSQL/migration readiness |
| `GET` | `/health/overhead` | API key | Sampled request-overhead snapshot |
| `GET` | `/metrics` | API key | Prometheus overhead metrics |

Health responses are `no-store` and include the local version where applicable. `/health` is unauthenticated liveness (`text/plain`, `x-ohmyomop-router-version`); `/health/ready` checks the injected `readiness()` port (PostgreSQL + migrations) and returns `200 {status:"ready", version}` when ready or `503 {status:"not_ready", reason}` otherwise. `/health/ready` does not replace PostgreSQL health checks in deployment orchestration; it reports this process's readiness boundary.

## Public error envelope and request ID

One envelope for every HTTP JSON error (`src/api/guard.ts:errorResponse` + `src/proxy/events/lifecycle.ts:writeErrorResponse` + planner rejection + pre-commit provider failure, sharing a dependency-neutral builder):

```json
{ "error": { "type": "error", "code": "<ProxyErrorCode>", "message": "...", "request_id": "<ProxyIngressContext.requestId>" } }
```

Headers: matching `x-request-id` (same value as `error.request_id`), `cache-control: no-store`, plus current security headers (`x-content-type-options: nosniff`, `x-frame-options: DENY`, CSP, HSTS when HTTPS). `error.type` is always `"error"`. `code` is the typed `ProxyErrorCode` / `ApplicationErrorKind` (`invalid_request`, `authentication_failed`, `model_not_found`, `capability_unsupported`, `provider_unavailable`, `context_overflow`, `stream_timeout`, `ambiguous_model`, etc.) — never derived by substring-matching provider messages. `request_id` is the single `ProxyIngressContext.requestId`; `readBoundedJson`, auth failures, malformed body, and every public `/v1` exit reuse it (no second `randomUUID` per request). OpenAPI contract is `PublicErrorBody` in `src/proxy/types/error-types.ts`.

Pre-commit vs post-commit:

- **Pre-commit** (no visible event yet, including reasoning as meaningful output) → typed HTTP JSON error above with the single envelope + headers.
- **Post-commit** (after first visible event) → one legal typed stream terminal frame for the requested surface and no second HTTP JSON body; `writeErrorResponse` never emits after commit. Provider failure after headers emits one sanitized surface-safe error event without `[DONE]`.

Disconnect: the `AbortSignal` listener installed in `src/api/v1.ts:handleProxy` stays alive through stream completion/cancellation — disposal transfers to the returned stream lifecycle; cancelling the reader aborts upstream exactly once, closes provider/lease/network/capture/telemetry exactly once (`createOwnedStream` + `createReleaseGate`), and telemetry finalization is joined to that outcome.

## Public proxy

Authentication accepts `Authorization: Bearer <key>` or `x-api-key`. Admission enforces API-key/IP limits and concurrency before normalization.

| Method | Path | Surface | Body |
|---|---|---|---|
| `GET` | `/v1/models` | model catalog (visible to API key, 30s merged DB+registry cache, static fallback when `discoverModels` returns `null`) | no body |
| `POST` | `/v1/chat/completions` | `openai-chat` | bounded by `RequestLimits.maxBodyBytes` (dual-enforced: `computeBodyLimit()` ingress + `RequestLimits`) |
| `POST` | `/v1/responses` | `openai-responses` | bounded by `RequestLimits.maxBodyBytes` (dual-enforced) |
| `POST` | `/v1/messages` | `anthropic-messages` | bounded by `RequestLimits.maxBodyBytes` (dual-enforced) |

The production body default is 10 MiB and is clamped 64 KiB–64 MiB via `OHMYOMOP_ROUTER_MAX_REQUEST_BODY_BYTES`. Ingress enforcement is dual: `src/api/guard.ts:computeBodyLimit()` reads live env per request for `readBoundedJson` using `ProxyIngressContext.requestId` for errors (10 MiB fallback, 64 KiB–64 MiB clamp; `CACHED_BODY_LIMIT` is deprecated), and the same value is propagated as `RequestLimits.maxBodyBytes` via `boundedIntegerFromEnv` in `src/runtime/runtime.ts:132` (+ `src/proxy/transport/sse.ts`) for translation/provider validation. Request limits also carry connect, first-body, idle, and total timeouts. The total deadline covers all provider attempts. `PROXY_API_KEY` is never logged; errors expose the single typed envelope above, never raw provider strings. Ambiguous bare model → `400 invalid_request` with `ambiguous_model`; no model → `404 model_not_found`.

### Non-streaming

The request is normalized into canonical protocol types (ordered `ContentPart`, `ToolChoice`, `ResponseFormatConstraint`, `RequiredRouteCapabilities` filtered pre-lease), sent through the selected provider adapter (47 defs, see PROVIDERS.md), transformed into a response document via `foldResponseEvents`, and projected to the requested surface. Errors expose typed `ProxyErrorCode` via the single envelope above (e.g. `context_overflow`, `model_not_found`, `ambiguous_model`, `capability_unsupported`, `provider_unavailable`, `stream_timeout`) with `x-request-id` + `no-store` + security headers. `capability_unsupported` is raised before any lease/network when the target cannot represent the request.

### Streaming

Responses use `text/event-stream` with `no-store`/`x-request-id`/security headers and matching `request_id` in any terminal error frame. The stream parser (`src/proxy/transport/sse.ts` + `src/proxy/transport/sse.ts:STREAM_BOUNDS`) enforces effective caps of 64 KiB line, 64 KiB event, 512 KiB buffered, 100k events (env overrides `OHMYOMOP_ROUTER_MAX_STREAM_*` are clamped to those maxima; `src/runtime/runtime.ts` raw defaults are higher but capped). Additional framing bounds include `framesPerPush` and `framesPerEvent`; outbound `STREAM_BOUNDS` per-frame + cumulative byte limits apply to Chat, Responses, and Messages (Chat-only frame-count removed). Lifecycle gate enforces one start, valid nonempty tool names, each tool closed, at most one usage, one stop, no post-terminal event. `[DONE]` is emitted only after a successful terminal event. If a provider fails after headers, the adapter emits one surface-safe typed terminal error event and closes without appending `[DONE]`. Reader cancellation aborts upstream exactly once and releases lease/network/capture/telemetry once; buffer `Buffer.concat` paths have bounded aggregate/frame checks via `STREAM_BOUNDS`.

---
_Generated: merged ARCHITECTURE + OPERATIONS + PROVIDERS + QUALITY + API into one comprehensive doc with per-section Mermaid + ASCII + tables._