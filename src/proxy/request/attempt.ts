/**
 * Route attempt — lease, retry budget before commit, commit gate.
 */

import type { AccountCandidate } from "../types/routing.js";
import type { Adapter, ProxyRequest as NewProxyRequest, ProviderOutput as NewProviderOutput } from "../types/request.js";
import type { CredentialKind, Surface } from "../types/surface.js";
import type { InternalFailure } from "../types/error-types.js";
import type { StreamEvent as NewStreamEvent } from "../types/stream.js";
import type { TranslationDiagnostic } from "../types/telemetry.js";
import type { AccountEligibilityPorts, CredentialSelector } from "../routing/account.js";
import type { NetworkSelector } from "../transport/network.js";
import type { ProviderConcurrencyLease } from "../../runtime/concurrency.js";
import { providerConcurrencyRegistry } from "../../runtime/concurrency.js";
import { beginProviderInFlight, endProviderInFlight } from "../../runtime/in-flight.js";
import { sanitizeMessage, deriveErrorSource } from "../types/error-types.js";
import { resolveModelWireSurface } from "../translate/policy.js";
import {
  clientIdentityForProfile,
  detectClientFormat,
  translateNonStreamResponse,
} from "../translate/cross-surface.js";
import type {
  AuthorizedProxyRequestInput,
  ProxyAuthorization,
  ProxyRequestDependencies,
  ProxyRoutePlan,
  RouteAttemptSelection,
} from "./prepare.js";

// ---------------------------------------------------------------------------
// Inlined route-attempt — lease, retry budget before commit, commit gate
// ---------------------------------------------------------------------------

const CODEX_PROXY_ENABLED = Bun.env.OHMYOMOP_ROUTER_CODEX_PROXY === "true";

export interface RouteAttemptState {
  readonly selectedAttempts: Map<number, RouteAttemptSelection>;
  readonly selectedCredentialKinds: Map<number, CredentialKind>;
  readonly selectedCandidateIds: Map<number, string>;
  readonly translationDiagnostics: TranslationDiagnostic[];
  readonly reactiveRefreshes: Set<string>;
  readonly accountCandidatesByProvider: Map<string, Promise<readonly AccountCandidate[]>>;
  reactiveRetryCandidateId: string | null;
  accountRetryCandidateId: string | null;
  candidateRetryId: string | null;
  nextCandidateIndex: number;
  successfulSelection: RouteAttemptSelection | null;
  successfulCandidateId: string | null;
}
export function markAccountRetry(state: RouteAttemptState, candidateId: string): void {
  state.accountRetryCandidateId = candidateId;
}
export function markCandidateRetry(state: RouteAttemptState, candidateId: string): void {
  state.candidateRetryId = candidateId;
}
function consumeRetryCandidate(state: RouteAttemptState): string | null {
  const candidateId = state.reactiveRetryCandidateId ?? state.accountRetryCandidateId ?? state.candidateRetryId;
  state.reactiveRetryCandidateId = null;
  state.accountRetryCandidateId = null;
  state.candidateRetryId = null;
  return candidateId;
}
function selectWireSurfaceAttempt(adapter: Adapter, candidate: { readonly modelId: string }, request: NewProxyRequest): Surface | null {
  const model = adapter.models.get(candidate.modelId);
  return resolveModelWireSurface(adapter.metadata, adapter.capabilities, model?.capabilities ?? null, (request as unknown as { sourceSurface: Surface }).sourceSurface);
}
export interface RouteAttemptContext {
  readonly input: { request: { signal: AbortSignal; headers: Headers }; authorization: ProxyAuthorization };
  readonly dependencies: ProxyRequestDependencies;
  readonly request: NewProxyRequest;
  readonly plan: ProxyRoutePlan;
  readonly deadlineMs: number;
  readonly capture: { request(value: unknown): void; response(value: unknown): void; observeResponse(response: Response): Response; settle(): Promise<void> } | null;
  readonly state: RouteAttemptState;
}
export function createRouteAttemptState(): RouteAttemptState {
  return { selectedAttempts: new Map(), selectedCredentialKinds: new Map(), selectedCandidateIds: new Map(), translationDiagnostics: [], reactiveRefreshes: new Set(), accountCandidatesByProvider: new Map(), reactiveRetryCandidateId: null, accountRetryCandidateId: null, candidateRetryId: null, nextCandidateIndex: 0, successfulSelection: null, successfulCandidateId: null };
}
export function getRouteAttemptSelection(state: RouteAttemptState): RouteAttemptSelection | null {
  return state.successfulSelection;
}
export function getTranslationDiagnostics(state: RouteAttemptState): readonly TranslationDiagnostic[] {
  return state.translationDiagnostics;
}
export function getSuccessfulCandidateId(state: RouteAttemptState): string | null {
  return state.successfulCandidateId;
}
export function getSelectedAttempt(state: RouteAttemptState, index: number): RouteAttemptSelection | null {
  return state.selectedAttempts.get(index) ?? null;
}
export function getSelectedCandidateId(state: RouteAttemptState, index: number): string | null {
  return state.selectedCandidateIds.get(index) ?? null;
}
export function getSelectedCredentialKind(state: RouteAttemptState, index: number): CredentialKind | null {
  return state.selectedCredentialKinds.get(index) ?? null;
}
export function markReactiveRefresh(state: RouteAttemptState, accountId: string, candidateId: string): boolean {
  if (state.reactiveRefreshes.has(accountId)) return false;
  state.reactiveRefreshes.add(accountId);
  state.reactiveRetryCandidateId = candidateId;
  return true;
}
export function hasNextCandidate(state: RouteAttemptState, plan: ProxyRoutePlan): boolean {
  return state.nextCandidateIndex < plan.candidates.length;
}
export function getNextCandidateId(state: RouteAttemptState, plan: ProxyRoutePlan): string | null {
  return plan.candidates[state.nextCandidateIndex]?.id ?? null;
}
export function clearAccountCandidates(state: RouteAttemptState, providerId: string): void {
  state.accountCandidatesByProvider.delete(providerId);
}
function createOwnedStream(
  events: AsyncIterable<NewStreamEvent>,
  release: () => Promise<void>,
  reportCleanupFailure: (error: unknown) => void,
): AsyncIterable<NewStreamEvent> {
  let source: AsyncIterator<NewStreamEvent> | null = null;
  let finished = false;
  const finish = async (hasPrimaryError: boolean): Promise<void> => {
    if (finished) return;
    finished = true;
    try { await release(); } catch (error) {
      if (hasPrimaryError) reportCleanupFailure(error);
      else throw error;
    }
  };
  const getSource = (): AsyncIterator<NewStreamEvent> => {
    source ??= events[Symbol.asyncIterator]();
    return source;
  };
  const iterator: AsyncIterator<NewStreamEvent> & AsyncIterable<NewStreamEvent> = {
    [Symbol.asyncIterator](): AsyncIterator<NewStreamEvent> {
      return iterator;
    },
    async next(): Promise<IteratorResult<NewStreamEvent>> {
      if (finished) return { done: true, value: undefined };
      let failed = false;
      try {
        const result = await getSource().next();
        if (result.done) await finish(false);
        return result;
      } catch (error) {
        failed = true;
        throw error;
      } finally {
        if (failed) await finish(true);
      }
    },
    async return(value?: unknown): Promise<IteratorResult<NewStreamEvent>> {
      let failed = false;
      try {
        const result: IteratorResult<NewStreamEvent> = source?.return === undefined
          ? { done: true, value }
          : await source.return(value);
        await finish(false);
        return result;
      } catch (error) {
        failed = true;
        throw error;
      } finally {
        if (failed) await finish(true);
      }
    },
    async throw(error?: unknown): Promise<IteratorResult<NewStreamEvent>> {
      let failed = false;
      try {
        if (source?.throw === undefined) {
          await finish(false);
          throw error;
        }
        const result = await source.throw(error);
        if (result.done) await finish(false);
        return result;
      } catch (primary) {
        failed = true;
        throw primary;
      } finally {
        if (failed) await finish(true);
      }
    },
  };
  return { [Symbol.asyncIterator]: () => iterator };
}

export function createRouteAttempt(context: RouteAttemptContext): (index: number) => Promise<NewProviderOutput> {
  const { input, dependencies, request, plan, deadlineMs, capture, state } = context;
  return async (index: number): Promise<NewProviderOutput> => {
    const remainingMs = deadlineMs - Date.now();
    if (remainingMs <= 0) {
      throw {
        statusCode: null,
        kind: "stream_timeout",
        retryable: true,
        routeScope: "provider",
        source: deriveErrorSource("stream_timeout", "provider"),
        safeMessage: "Provider request exceeded the total timeout",
        retryAt: null,
        failureCode: "stream_total_timeout",
        upstream: null,
      } satisfies InternalFailure;
    }
    let candidate: import("../types/routing.js").RouteCandidate | undefined;
    const retryCandidateId = consumeRetryCandidate(state);
    if (retryCandidateId !== null) {
      candidate = plan.candidates.find((item) => item.id === retryCandidateId);
    } else {
      const candidateIndex = state.nextCandidateIndex;
      state.nextCandidateIndex += 1;
      candidate = plan.candidates[candidateIndex];
    }
    if (!candidate) throw { statusCode: 503, kind: "provider_unavailable", retryable: true, routeScope: "provider", source: deriveErrorSource("provider_unavailable", "provider"), safeMessage: "No route candidate available", retryAt: null };
    state.selectedCandidateIds.set(index, candidate.id);
    const adapter = dependencies.providers.get(candidate.providerId);
    if (!adapter) throw { statusCode: 503, kind: "credential_unavailable", retryable: false, routeScope: "provider", source: deriveErrorSource("credential_unavailable", "provider"), safeMessage: "Provider is not configured", retryAt: null };

    let credentialLeaseId: string | null = null;
    let networkRelease: (() => Promise<void>) | null = null;
    let providerInFlight = false;
    let providerConcurrencyLease: ProviderConcurrencyLease | null = null;
    let releasePromise: Promise<void> | null = null;
    let cleanupFailureReported = false;
    let abortListener: (() => void) | null = null;
    const reportCleanupFailure = (error: unknown): void => {
      if (cleanupFailureReported) return;
      cleanupFailureReported = true;
      console.warn(`[RouteAttempt] cleanup failed: ${sanitizeMessage(String(error))}`);
    };
    const release = (): Promise<void> => {
      if (releasePromise !== null) return releasePromise;
      releasePromise = (async () => {
        const failures: unknown[] = [];
        const pendingReleases: Promise<void>[] = [];
        const captureRelease = (operation: () => Promise<void>): void => {
          try {
            pendingReleases.push(Promise.resolve(operation()).catch((error: unknown) => {
              failures.push(error);
            }));
          } catch (error) {
            failures.push(error);
          }
        };
        const concurrencyLease = providerConcurrencyLease;
        providerConcurrencyLease = null;
        if (concurrencyLease !== null) captureRelease(() => concurrencyLease.release());
        if (providerInFlight) {
          providerInFlight = false;
          try { endProviderInFlight(candidate!.providerId); } catch (error) { failures.push(error); }
        }
        const releaseNetwork = networkRelease;
        networkRelease = null;
        if (releaseNetwork !== null) captureRelease(releaseNetwork);
        const leaseId = credentialLeaseId;
        credentialLeaseId = null;
        if (leaseId !== null) captureRelease(() => (dependencies.accounts as unknown as { release: (id: string) => Promise<void> }).release(leaseId));
        if (abortListener !== null) {
          input.request.signal.removeEventListener("abort", abortListener);
          abortListener = null;
        }
        await Promise.all(pendingReleases);
        if (failures.length > 0) throw failures[0];
      })();
      return releasePromise;
    };
    const releaseAfterPrimary = async (): Promise<void> => {
      try { await release(); } catch (error) { reportCleanupFailure(error); }
    };
    const attachAbortCleanup = (): void => {
      if (abortListener !== null) return;
      abortListener = () => { void release().catch(reportCleanupFailure); };
      input.request.signal.addEventListener("abort", abortListener, { once: true });
      if (input.request.signal.aborted) void release().catch(reportCleanupFailure);
    };
    try {
      const adapterNeedsCredential = adapter.metadata.credentialKind !== "none";
      const providerRouting = dependencies.getProviderRouting?.(candidate.providerId);
      const affinityKey = input.authorization.apiKeyId ?? input.authorization.trustedIdentity ?? "anonymous";
      let stickyLimit: number | undefined;
      if ((request as unknown as { cacheKey?: string }).cacheKey !== undefined) {
        stickyLimit = Math.max(1, providerRouting?.stickyLimit ?? 1);
      } else if (providerRouting?.useStickyLimit === true) {
        stickyLimit = providerRouting.stickyLimit;
      }
      let accountCandidatesPromise = state.accountCandidatesByProvider.get(candidate.providerId);
      if (accountCandidatesPromise === undefined) {
        accountCandidatesPromise = dependencies.accountCandidates(candidate.providerId).catch((error: unknown) => { state.accountCandidatesByProvider.delete(candidate.providerId); throw error; });
        state.accountCandidatesByProvider.set(candidate.providerId, accountCandidatesPromise);
      }
      const credential = adapterNeedsCredential ? await (dependencies.accounts as unknown as { select: (input: unknown) => Promise<null | { selection: { leaseId: string; accountId: string; secret: string }; account: { credentialKind: CredentialKind } }> }).select({ providerId: candidate.providerId, candidates: await accountCandidatesPromise, strategy: providerRouting?.strategy ?? "priority", affinityKey, stickyLimit, modelId: candidate.modelId, preferredAccountId: candidate.accountId }) : null;
      if (adapterNeedsCredential && credential === null) throw { statusCode: 503, kind: "credential_unavailable", retryable: true, routeScope: "account", source: deriveErrorSource("credential_unavailable", "account"), safeMessage: "No eligible account available", retryAt: null };
      credentialLeaseId = (credential as unknown as { selection?: { leaseId: string } } | null)?.selection?.leaseId ?? null;
      const network = await dependencies.network.select({
        providerId: candidate.providerId,
        affinityKey,
        sticky: (request as unknown as { cacheKey?: string }).cacheKey !== undefined || providerRouting?.useStickyLimit === true,
        preferDirect: candidate.providerId === "codex" && !CODEX_PROXY_ENABLED,
        preferredProxyId: candidate.proxyId,
      });
      if (network === null) throw { statusCode: 503, kind: "network_unavailable", retryable: true, routeScope: "proxy", source: deriveErrorSource("network_unavailable", "proxy"), safeMessage: "No outbound network path available", retryAt: null };
      networkRelease = (network.selection as unknown as { release?: () => Promise<void> }).release ?? null;
      const selected = { accountId: (credential as unknown as { selection?: { accountId: string } } | null)?.selection?.accountId ?? null, proxyId: (network as unknown as { proxyId: string }).proxyId } satisfies RouteAttemptSelection;
      state.selectedAttempts.set(index, selected);
      state.selectedCredentialKinds.set(index, (credential as unknown as { account?: { credentialKind: CredentialKind } } | null)?.account?.credentialKind ?? "none");
      state.selectedCandidateIds.set(index, candidate.id);
      const wireSurface = selectWireSurfaceAttempt(adapter, candidate, request);
      if (wireSurface === null) throw { statusCode: 400, kind: "capability_unsupported", retryable: false, routeScope: "provider", source: deriveErrorSource("capability_unsupported", "provider"), safeMessage: `Provider "${candidate.providerId}" cannot translate this protocol surface`, retryAt: null };
      const resolvedTarget = adapter.resolveTarget(candidate.modelId || (request as unknown as { model: string }).model, wireSurface);
      const target = {
        ...resolvedTarget,
        surface: wireSurface,
        upstreamModelId: (resolvedTarget as unknown as { upstreamModelId?: string }).upstreamModelId ?? candidate.modelId,
      };
      try {
        providerConcurrencyLease = await providerConcurrencyRegistry.acquire(candidate.providerId, (target as unknown as { upstreamModelId?: string }).upstreamModelId ?? candidate.modelId, input.request.signal);
      } catch (error) {
        if (input.request.signal.aborted) {
          throw {
            statusCode: null,
            kind: "client_aborted",
            retryable: false,
            routeScope: null,
            source: deriveErrorSource("client_aborted", null),
            safeMessage: "Request aborted by client",
            retryAt: null,
          };
        }
        throw error;
      }
      beginProviderInFlight(candidate.providerId);
      providerInFlight = true;
      attachAbortCleanup();
      const providerRemainingMs = deadlineMs - Date.now();
      if (providerRemainingMs <= 0) {
        throw {
          statusCode: null,
          kind: "stream_timeout",
          retryable: true,
          routeScope: "provider",
          source: deriveErrorSource("stream_timeout", "provider"),
          safeMessage: "Provider request exceeded the total timeout",
          retryAt: null,
          failureCode: "stream_total_timeout",
          upstream: null,
        } satisfies InternalFailure;
      }
      let output: NewProviderOutput;
      try {
        const attemptRequest = {
          ...request,
          limits: {
            ...request.limits,
            totalTimeoutMs: Math.min(request.limits.totalTimeoutMs, providerRemainingMs),
          },
        };
        output = await adapter.call({ target, request: attemptRequest as unknown as import("../types/request.js").ProxyRequest, credential: credential?.selection.secret ?? "", network: network.selection, signal: input.request.signal, headers: input.request.headers, capture: capture ?? undefined, recordDiagnostic: (diagnostic) => { if (state.translationDiagnostics.length < 32) state.translationDiagnostics.push(diagnostic); }, endpoint: null });
      } catch (error) {

        const mapped = adapter.mapError(error);
        await releaseAfterPrimary();
        throw mapped;
      }
      state.successfulSelection = selected;
      state.successfulCandidateId = candidate.id;
      if (output.mode === "stream") {
        return { ...output, events: createOwnedStream(output.events as unknown as AsyncIterable<NewStreamEvent>, release, reportCleanupFailure) as unknown as AsyncIterable<import("../types/stream.js").StreamEvent> };
      }
      await release();
      if ((target as unknown as { surface?: string }).surface !== (request as unknown as { sourceSurface?: string }).sourceSurface) return { ...output, body: translateNonStreamResponse(output.body as unknown as Record<string, unknown>, (target as unknown as { surface: Surface }).surface ?? wireSurface, (request as unknown as { sourceSurface: Surface }).sourceSurface, (request as unknown as { model: string }).model) } as unknown as NewProviderOutput;
      return output;
    } catch (error) {
      await releaseAfterPrimary();
      throw error;
    }
  };
}
