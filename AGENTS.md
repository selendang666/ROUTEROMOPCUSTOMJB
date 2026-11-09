# AGENTS.md — Oh My Omop - Router

> Single instruction set for any coding agent. Contains conventions and coding way only — not file tags. Follow exactly; do not invent alternatives. If a convention does not fit the task, ask the user before diverging.

> **CRITICAL — Accuracy is safety:** Inference may be OFF. Never invent models, versions, pricing, APIs, or capabilities. Verify via search/read or state `unable to verify — inference off / data unavailable`.

## 1. Project

- Self-hosted AI proxy + authenticated dashboard. Accepts multiple public surfaces that can route to any compatible upstream.
- PostgreSQL is the durable config authority; telemetry is SQLite/D1 (bounded, not Postgres); Redis is optional coordination/cache.
- Version is single-source via `package.json` + `dashboard/package.json` + `runtime.ts` (do not hardcode).

## 2. Tech Stack

- Runtime: Bun, Elysia, TypeScript strict, PostgreSQL, Redis (optional).
- No `ai-sdk` / `@ai-sdk/*` / `@anthropic-ai/*` dependencies.
- Use native `TextEncoder`/`TextDecoder` only for UTF-8; do not create project-owned `encoder`/`decoder`/`codec` modules.
- Exact dependency versions live in `package.json` / lockfile — do not hardcode here.

## 3. Code Organization

- Keep modules small and single-purpose; group by domain, split large files.
- No barrel re-exports that hide ownership — import directly from the owning file.
- Do not codify a fixed source tree here; layout may evolve. Decide structure per concern at edit time.
- When a migration is approved, update implementation, callers, tests, and docs atomically; do not keep obsolete aliases.

### 3.1 Architecture Evolution (invariants)

- Request execution has one production path and one commit policy; remove the obsolete path after cutover.
- Provider quirks are typed immutable data consumed by pure projections — no scattered `if (providerId)` in shared protocol code.
- Tool assembly is occurrence-aware; never emit anonymous tool calls or fabricate empty results; never retry after semantic commit.
- History is not destructively summarized by default.
- Passthrough requires explicit same-ecosystem declaration and still passes auth, SSRF, header, lifecycle, and kill-switch checks.
- Capability preflight and total-deadline ordering are mandatory.
- Provider quirks/execution policy are registered exactly once as `Record<string, ...>` data in `src/proxy/policy/profiles.ts`; `applyProviderQuirkPolicy`/`applyRequiredProviderHeaders` have exactly one implementation, in `src/proxy/policy/projection.ts` — never re-implement or re-export a second copy elsewhere.
- Client-facing proxy errors have exactly one serializer: `writeErrorResponse` (`src/proxy/events/commit.ts`), which preserves `failure.statusCode` and `failure.upstream?.providerCode`. Do not add a second error-to-Response mapping.
- Every `parseUpstreamFailure(response, ...)` call site must pass the real `providerId` from the in-scope `ProviderRequest.target.providerId` — never call it with the default `"unknown"`.
- Coordination (`src/persistence/coordination.ts`) and telemetry cache (`src/persistence/telemetry/cache/redis.ts`) fall back to in-memory automatically when `REDIS_URL` is unset or unreachable; `persistence.coordination.degraded()` must stay wired into the startup log and console health endpoint whenever either is touched.

## 4. Naming & Language

- Files: `kebab-case`. Types/interfaces: `PascalCase`. Variables/functions: `camelCase`. Env vars: `SCREAMING_SNAKE`.
- Use `transform` / `translate` / `parse` for protocol/stream.
- Commit messages and docs in English; chat may be Indonesian when user uses it.

## 5. TypeScript

- `strict: true`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `module: NodeNext`, `target: es2022`.
- Prefer `interface` for shapes, `type` for unions/mapped/conditional.
- No `any` without comment, no `!` without justification, no `as` for object literals. Use `import type`.
- Doc comment (`/** */`) on every exported function/interface/type with `@param`/`@returns` where non-trivial.

## 5.1 Testing

- Unit: colocated `src/**/*.test.ts` (Bun native). Contract/integration: `test/*.test.ts` (fixtures/DB/network). Dashboard: `dashboard/test/` (Vitest).
- Naming: `*.test.ts` only. No `*.spec.ts`, no `__tests__/`.
- `tsconfig.json` is `noEmit: true`; Bun runs TS directly.
- Run: `bun test --timeout 60000 ./src`, `bun test --timeout 60000 ./test`, `cd dashboard && bun run test`. Use `bun test --coverage` for coverage.

## 6. Environment

- Mandatory (fail-fast): `PORT`, `DATABASE_URL` (`postgres://` with hostname), `APP_SECRET` (≥32 chars, sole credential encryption source via SHA-256), `PROXY_API_KEY` (required in production).
- Optional (with defaults): `HOST`, `REDIS_URL`, `SQLITE_PATH` / `TELEMETRY_D1_URL`+`TELEMETRY_D1_TOKEN`, `TRUST_PROXY`, and bounded `OHMYOMOP_ROUTER_*` limits (body/stream/route/telemetry/overhead). See `.env.example` as source of truth.
- Rules: `APP_SECRET` is the only encryption source; `DATABASE_URL` defines all PG connection info; telemetry is pipeline-direct (no shims); `TRUST_PROXY` gates client IP.

## 7. Identity Boundary

- Local version appears only on health, dashboard, and logs.
- Upstream uses reference-client identities, never the local project identity.

## 8. Provider Conventions

- One definition per built-in provider (plus N DB-defined custom providers). Custom providers may expand surfaces when declared.
- Discovery is tolerant (`/models` plus OAuth inline where applicable) with static fallback retained when unavailable.
- Capability projection is mandatory: emit legal target equivalent or throw typed `capability_unsupported` before dispatch — no silent downgrade.

## 9. Persistence & Runtime

- Migrations run with advisory lock and checksum, contiguous version check; backup is bounded and excludes ephemeral quota/telemetry.
- Telemetry is bounded (ring buffer, chunked flush, WAL/NORMAL, cache clamp).
- Runtime owns config/admission/diagnostics; persistence owns durable state; bootstrap composes both.

## 10. Verification

```sh
bunx tsc --noEmit
bun run version:check
bun test --timeout 60000 ./src
bun test --timeout 60000 ./test
bun test --timeout 60000 src/providers
bun build --target bun src/main.ts --outfile /tmp/verify.js && rm /tmp/verify.js
bun run scripts/dev/verify.ts
cd dashboard && bun run test
```

## 11. Documentation

- Docs live in `docs/` (single comprehensive + sectioned files with Mermaid + ASCII + tables). When ownership changes, update implementation, callers, tests, and docs together.
- If a convention in this file does not fit the task, **ask the user** before diverging — do not silently invent a new convention.
