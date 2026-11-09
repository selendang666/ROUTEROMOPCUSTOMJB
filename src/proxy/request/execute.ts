/**
 * Request executor — snapshot once, compression once, lease once, commit once.
 * Owns CommitGate, OnceLease, RequestExecutor, runProxyRequest.
 */

import type { Adapter, ClientIdentity, ProviderOutput, ProviderRequest, ProxyRequest as NewProxyRequest, RunProxyRequestInput, PresentedProxyResponse } from "../types/request.js";
import type { ProxyEndpoint } from "../types/routing.js";
import type { AffinityKey, RoutingSnapshot, LeaseHandle, RouteCandidate } from "../types/routing.js";
import type { ApplicationErrorKind, InternalFailure, UpstreamFailureSummary } from "../types/error-types.js";
import type { ProviderUsage, TelemetryEvent, TelemetryPort, TranslationDiagnostic, WebSearchFallback, RequestRoutingMetadata } from "../types/telemetry.js";
import type { StreamEvent } from "../types/stream.js";
import type { Surface } from "../types/surface.js";
import type { AdmissionUsage, ApiKeyAdmission } from "../../runtime/key.js";
import type { AccountEligibilityPorts } from "../routing/account.js";
import { createAccountManager } from "./prepare.js";
import { createRoutePlan } from "../routing/plan.js";
import type { CliModelMappingSnapshot } from "../routing/mapping.js";
import { applyCompression } from "../../compression/apply-compression.js";
import type { TokenSaverConfig } from "../../compression/token-saver.js";
import { currentOverheadReport, markOverhead } from "../../runtime/overhead.js";
import { isRouteAllowed } from "../../api/guard.js";
import { isRetryableError } from "../transport/errors.js";
import { createInternalFailure } from "../errors.js";
import { findCacheBreakpoint } from "../translate/cache.js";
import { createCleanupStack, deriveErrorSource, normalizeInternalFailure, sanitizeMessage } from "../types/error-types.js";
import { decrementInFlight, incrementInFlight } from "../../runtime/in-flight.js";
import { createCommitGate, createReleaseGate, isCommitEvent, recoverCall, writeErrorResponse, writeResponse } from "../events/commit.js";
import { clientIdentityForProfile, detectClientFormat, normalizeRequest } from "../translate/cross-surface.js";
import { resolveCliModelMapping } from "../routing/mapping.js";
import { estimateRequestTokens, exceedsContextWindow } from "../../runtime/key.js";
import { runtimeMemoryLimits } from "../../runtime/limits.js";
import { translateSurfaceStream } from "../translate/stream.js";
import { mapWithConcurrency } from "../../runtime/runtime.js";
import { createPayloadCapture } from "./capture.js";
import {
  type AuthorizedProxyRequestInput,
  type PreparedProxyRequest,
  type ProxyAuthorization,
  type ProxyRequestDependencies,
  type ProxyRequestLogEvent,
  type ProxyRoutePlan,
  type ProviderPort,
  type RequestOptions,
  type RequestPersistencePorts,
  type RouteAttemptSelection,
  type TelemetryStartHandle,
  admissionInputTokens,
  normalizeProviderError,
  prepareProxyRequest,
  selectWireSurface,
  telemetryStart,
} from "./prepare.js";
import {
  type RouteAttemptContext,
  type RouteAttemptState,
  clearAccountCandidates,
  createRouteAttempt,
  createRouteAttemptState,
  getNextCandidateId,
  getRouteAttemptSelection,
  getSelectedAttempt,
  getSelectedCandidateId,
  getSelectedCredentialKind,
  getSuccessfulCandidateId,
  getTranslationDiagnostics,
  hasNextCandidate,
  markAccountRetry,
  markCandidateRetry,
  markReactiveRefresh,
} from "./attempt.js";

// ---------------------------------------------------------------------------
// Commit gate — exactly once, no retry after commitment
// ---------------------------------------------------------------------------

export async function executeProxyRequest(
  input: AuthorizedProxyRequestInput,
  dependencies: ProxyRequestDependencies,
): Promise<PresentedProxyResponse> {
  const requestId = input.request.requestId ?? crypto.randomUUID();
  const startedAt = performance.now();
  const client = clientIdentityForProfile(detectClientFormat(input.request.endpoint, input.request.surface, input.request.headers, input.request.body).profile);
  const telemetry = telemetryStart(input.request, requestId, client, input.authorization, dependencies.telemetry);
  const captureSink = dependencies.createPayloadCapture?.(requestId) ?? null;
  const capture = captureSink === null ? null : createPayloadCapture(requestId, captureSink as unknown as Parameters<typeof createPayloadCapture>[1]);
  if (capture !== null) capture.request?.(input.request.body);
  let requestLogSettled = false;
  const emitRequestLog = (event: ProxyRequestLogEvent): void => {
    const isTerminal = event.event === "complete" || event.event === "failed" || event.event === "aborted";
    if (isTerminal) {
      if (requestLogSettled) return;
      requestLogSettled = true;
    }
    dependencies.onRequestLog?.(event);
  };
  const cleanup = createCleanupStack();
  let admissionLease: ReturnType<ApiKeyAdmission["acquire"]> | null = null;
  let admissionSettled = false;
  let admissionEstimate = 0;
  let normalizedRequest: NewProxyRequest | undefined;
  let translationDiagnostics: readonly TranslationDiagnostic[] = [];
  let resolvedPlan: ProxyRoutePlan | undefined;
  const routeAttemptState = createRouteAttemptState();
  const currentSelection = (index?: number): { accountId: string | null; proxyId: string | null } => {
    const attempt = index === undefined
      ? getRouteAttemptSelection(routeAttemptState)
      : getSelectedAttempt(routeAttemptState, index);
    return { accountId: attempt?.accountId ?? null, proxyId: attempt?.proxyId ?? null };
  };
  const webSearchFallbacks: WebSearchFallback[] = [];
  let streamHandedOff = false;
  const routeMetadata = (errorMessage: string | null = null): RequestRoutingMetadata => {
    const request = normalizedRequest;
    const plan = resolvedPlan;
    const successfulCandidateId = getSuccessfulCandidateId(routeAttemptState);
    const candidate = successfulCandidateId === null ? (plan?.candidates[0] ?? null) : (plan?.candidates.find((item) => item.id === successfulCandidateId) ?? plan?.candidates[0] ?? null);
    const adapter = candidate === null ? undefined : dependencies.providers.get(candidate.providerId);
    let wireSurface: Surface | null = null;
    let upstreamModel: string | null = candidate?.modelId ?? null;
    if (adapter !== undefined && candidate !== null && request !== undefined) {
      wireSurface = selectWireSurface(adapter, candidate, request);
      if (wireSurface !== null) {
        try {
          upstreamModel = adapter.resolveTarget(candidate.modelId, wireSurface).modelId;
        } catch {}
      }
    }
    return {
      requestedModel: request?.model ?? null,
      mappedModel: plan?.requestedModel ?? request?.model ?? null,
      upstreamModel,
      wireSurface,
      errorMessage,
      cacheKeyPresent: request?.cacheKey !== undefined,
      cacheBreakpointPresent: request === undefined ? false : findCacheBreakpoint(request as unknown as import("../types/request.js").ProxyRequest) !== null,
      ...(candidate?.searchRoute === undefined ? {} : { webSearchRoute: candidate.searchRoute, webSearchPassthrough: candidate.searchRoute === "passthrough" }),
      ...(webSearchFallbacks.length === 0 ? {} : { webSearchFallbacks: [...webSearchFallbacks] }),
      ...((translationDiagnostics.length === 0 && getTranslationDiagnostics(routeAttemptState).length === 0) ? {} : { translationDiagnostics: [...translationDiagnostics, ...getTranslationDiagnostics(routeAttemptState)].slice(0, 32) }),
    } as unknown as RequestRoutingMetadata;
  };
  const settleAdmission = (usage: AdmissionUsage | null): void => {
    if (admissionSettled || admissionLease === null) return;
    admissionSettled = true;
    if (usage === null) admissionLease.release();
    else admissionLease.commit(usage);
  };

  incrementInFlight();
  try {
    const prepared = await prepareProxyRequest(input as unknown as Parameters<typeof prepareProxyRequest>[0], dependencies as unknown as Parameters<typeof prepareProxyRequest>[1]);
    const currentRequest = prepared.request;
    normalizedRequest = currentRequest;
    translationDiagnostics = prepared.translationDiagnostics as unknown as readonly TranslationDiagnostic[];
    admissionEstimate = prepared.admissionEstimate;
    const apiKey = input.authorization.apiKey;
    if (dependencies.admission !== undefined && apiKey !== undefined && apiKey !== null) {
      try {
        admissionLease = dependencies.admission.acquire(apiKey, admissionEstimate);
      } catch (error) {
        const shape = error as { kind?: unknown; safeMessage?: unknown };
        throw createInternalFailure({
          kind: shape.kind === "concurrency_exceeded" ? "concurrency_exceeded" : "quota_exceeded",
          safeMessage: typeof shape.safeMessage === "string" && shape.safeMessage.length > 0
            ? shape.safeMessage
            : "API key limit exceeded",
          statusCode: 429,
          retryable: false,
        });
      }
    }

    const affinity: AffinityKey =
      input.authorization.apiKeyId !== null && input.authorization.apiKeyId !== undefined
        ? { namespace: "api_key", value: input.authorization.apiKeyId }
        : { namespace: "trusted_identity", value: input.authorization.trustedIdentity ?? "anonymous" };
    const disableRemoteMapping = (apiKey as unknown as { disableRemoteMapping?: boolean })?.disableRemoteMapping === true;
    const routePlan = await dependencies.resolveRoutes(currentRequest, affinity, client, disableRemoteMapping);
    const candidates = routePlan.candidates.filter((candidate) => isRouteAllowed(candidate.providerId, candidate.modelId, input.authorization as unknown as Parameters<typeof isRouteAllowed>[2], routePlan.requestedModel));
    resolvedPlan = { ...routePlan, candidates } as ProxyRoutePlan;
    if (resolvedPlan.candidates.length === 0) {
      const unsupported = routePlan.unsupportedReason !== undefined;
      const kind: ApplicationErrorKind = unsupported ? "capability_unsupported" : "model_not_found";
      const safeMessage = (routePlan as unknown as { unsupportedReason?: string }).unsupportedReason ?? "No eligible route found";
      throw {
        statusCode: unsupported ? 400 : 404,
        kind,
        retryable: false,
        routeScope: null,
        source: deriveErrorSource(kind, null),
        safeMessage,
        retryAt: null,
        failureCode: null,
        upstream: null,
      } satisfies InternalFailure;
    }
    emitRequestLog({
      event: "incoming",
      requestId,
      endpoint: input.request.endpoint,
      providerId: resolvedPlan.candidates[0]?.providerId ?? null,
      model: currentRequest.model,
      status: null,
      errorKind: null,
      durationMs: Math.max(0, performance.now() - startedAt),
      inputTokens: null,
      outputTokens: null,
      cachedTokens: null,
      cacheWriteTokens: null,
      messageCount: currentRequest.messages.length,
      toolCount: currentRequest.tools.length,
      clientName: client.name,
      clientSource: client.source,
      clientIp: input.request.clientIp ?? null,
      accountId: null,
      proxyId: null,
      reasoningTokens: null,
    });

    const deadlineMs = Date.now() + currentRequest.limits.totalTimeoutMs;
    const attempt = createRouteAttempt({
      input: input as unknown as RouteAttemptContext["input"],
      dependencies: dependencies as unknown as RouteAttemptContext["dependencies"],
      request: currentRequest as unknown as RouteAttemptContext["request"],
      plan: resolvedPlan as unknown as RouteAttemptContext["plan"],
      deadlineMs,
      capture: capture as unknown as RouteAttemptContext["capture"],
      state: routeAttemptState,
    });
    let reactiveRetryReady = false;

    const output = await recoverCall({
      attempt: attempt as unknown as Parameters<typeof recoverCall>[0]["attempt"],
      maxAttempts: Math.min(Math.max(resolvedPlan.webSearch === true ? resolvedPlan.maxAttempts ?? 2 : dependencies.maxAttempts ?? 2, 1), 6),
      signal: input.request.signal,
      cleanup: cleanup as unknown as Parameters<typeof recoverCall>[0]["cleanup"],
      mapError: normalizeProviderError as unknown as Parameters<typeof recoverCall>[0]["mapError"],
      onFailure: async (error: InternalFailure, index: number) => {
        const candidates = resolvedPlan?.candidates ?? [];
        const selectedCandidateId = getSelectedCandidateId(routeAttemptState, index);
        const candidate = selectedCandidateId === null ? null : (candidates.find((item) => item.id === selectedCandidateId) ?? null);
        const selected = getSelectedAttempt(routeAttemptState, index);
        if (candidate !== null) {
          const failureUpdate = dependencies.onRouteFailure?.(candidate, error, selected);
          if (failureUpdate !== undefined) void failureUpdate.catch(() => {});
          if (error.routeScope === "account") {
            clearAccountCandidates(routeAttemptState, candidate.providerId);
          }
        }
        const authFailure = (error.statusCode === 401 || error.statusCode === 403) && (error.kind === "authentication_failed" || error.kind === "authorization_denied");
        const accountId = selected?.accountId ?? null;
        if (candidate !== null && error.routeScope === "account" && !authFailure) {
          markAccountRetry(routeAttemptState, candidate.id);
          return;
        }
        const canReact = authFailure && candidate !== null && accountId !== null && getSelectedCredentialKind(routeAttemptState, index) === "oauth" && markReactiveRefresh(routeAttemptState, accountId, candidate.id);
        if (canReact) {
          const refresh = (dependencies.accounts as unknown as { forceRefresh: (id: string) => Promise<unknown> }).forceRefresh(accountId);
          void refresh.catch(() => {});
          reactiveRetryReady = false;
          return;
        }
        const replacementId = resolvedPlan === undefined ? null : getNextCandidateId(routeAttemptState, resolvedPlan);
        const replacement = replacementId === null ? null : (candidates.find((item) => item.id === replacementId) ?? null);
        if (candidate !== null && error.kind === "provider_unavailable" && error.retryable && replacement === null) {
          markCandidateRetry(routeAttemptState, candidate.id);
        }
        if (candidate !== null && resolvedPlan?.webSearch === true && replacement?.id !== candidate.id) {
          webSearchFallbacks.push({ previousRouteId: candidate.id, replacementRouteId: replacement?.id ?? null, reason: error.kind } as unknown as WebSearchFallback);
        }
        if (candidate !== null && (error.routeScope === "account" || error.routeScope === "proxy" || replacement !== null)) {
          emitRequestLog({
            event: "switch",
            requestId,
            endpoint: input.request.endpoint,
            providerId: candidate.providerId,
            model: candidate.modelId,
            status: error.statusCode,
            errorKind: error.kind,
            durationMs: Math.max(0, performance.now() - startedAt),
            inputTokens: null,
            outputTokens: null,
            cachedTokens: null,
            cacheWriteTokens: null,
            reasoningTokens: null,
            messageCount: normalizedRequest?.messages.length ?? 0,
            toolCount: normalizedRequest?.tools.length ?? 0,
            clientName: client.name,
            clientSource: client.source,
            clientIp: input.request.clientIp ?? null,
            accountId: selected?.accountId ?? null,
            proxyId: selected?.proxyId ?? null,
            switch: {
              scope: error.routeScope === null ? "provider" : error.routeScope,
              fromCandidateId: candidate.id,
              toCandidateId: replacement?.id ?? null,
              fromAccountId: selected?.accountId ?? null,
              toAccountId: null,
              reason: error.kind,
            },
          });
        }
        if (candidate !== null && (error.routeScope === "account" || error.routeScope === "proxy")) {
          await dependencies.onRouteSwitch?.({
            scope: error.routeScope,
            from: candidate.id,
            to: replacement?.id ?? candidate.id,
            reason: error.kind,
            previousRouteId: candidate.id,
            replacementRouteId: replacement?.id ?? null,
            occurredAt: new Date().toISOString(),
          });
        }
      },
      shouldRetry: (error: InternalFailure) => {
        if (deadlineMs - Date.now() <= 0) return false;
        const authFailure = (error.statusCode === 401 || error.statusCode === 403) && (error.kind === "authentication_failed" || error.kind === "authorization_denied");
        if (reactiveRetryReady && authFailure) {
          reactiveRetryReady = false;
          return true;
        }
        if (authFailure && resolvedPlan !== undefined && hasNextCandidate(routeAttemptState, resolvedPlan)) return true;
        if (resolvedPlan?.webSearch === true && hasNextCandidate(routeAttemptState, resolvedPlan)) return true;
        if (resolvedPlan === undefined) return false;
        const retryCandidateAvailable =
          hasNextCandidate(routeAttemptState, resolvedPlan)
          || routeAttemptState.reactiveRetryCandidateId !== null
          || routeAttemptState.accountRetryCandidateId !== null
          || routeAttemptState.candidateRetryId !== null;
        return error.retryable && !input.request.signal.aborted && retryCandidateAvailable;
      },
    } as unknown as Parameters<typeof recoverCall>[0]);
    const plan = resolvedPlan;
    const providerId = (): string | null => {
      const successfulCandidateId = getSuccessfulCandidateId(routeAttemptState);
      return successfulCandidateId === null ? (plan.candidates[0]?.providerId ?? null) : (plan.candidates.find((candidate) => candidate.id === successfulCandidateId)?.providerId ?? plan.candidates[0]?.providerId ?? null);
    };
    const reportRouteSuccess = async (): Promise<void> => {
      const successfulCandidateId = getSuccessfulCandidateId(routeAttemptState);
      const candidate = successfulCandidateId === null ? null : (plan.candidates.find((item) => item.id === successfulCandidateId) ?? null);
      if (candidate !== null) await dependencies.onRouteSuccess?.(candidate, getRouteAttemptSelection(routeAttemptState) as unknown as RouteAttemptSelection);
    };
    let responseStatus: number | null = null;
    let presentedOutput: ProviderOutput = output as unknown as ProviderOutput;
    const clientStreamEvents: StreamEvent[] = [];
    if ((output as unknown as ProviderOutput).mode === "non_stream") {
      const usage: ProviderUsage | undefined = (output as unknown as ProviderOutput).usage;
      const usageForAdmission = usage === undefined || usage === null ? { inputTokens: admissionEstimate, outputTokens: 0 } : { inputTokens: admissionInputTokens(usage, admissionEstimate), outputTokens: (usage as unknown as { outputTokens?: number }).outputTokens ?? usage.completionTokens ?? 0 };
      settleAdmission(usageForAdmission as unknown as AdmissionUsage);
    } else {
      presentedOutput = {
        ...(output as unknown as ProviderOutput),
        events: (async function* () {
          let observedUsage: ProviderUsage | null = null;
          let terminalReason: string | null = null;
          let streamErrorKind: ApplicationErrorKind | null = null;
          let streamErrorMessage: string | null = null;
          let streamErrorUpstream: UpstreamFailureSummary | null = null;
          let firstByteRecorded = false;
          let firstTokenRecorded = false;
          try {
            for await (const event of (output as unknown as ProviderOutput & { events: AsyncIterable<StreamEvent> }).events) {
              if (clientStreamEvents.length < 128) clientStreamEvents.push(event);
              if (!firstByteRecorded) {
                (telemetry as unknown as TelemetryStartHandle).recordFirstByte?.();
                firstByteRecorded = true;
              }
              if (!firstTokenRecorded && event.type === "text_delta") {
                (telemetry as unknown as TelemetryStartHandle).recordFirstToken?.();
                firstTokenRecorded = true;
              }
              if (event.type === "usage") observedUsage = event.usage;
              if (event.type === "message_stop") {
                terminalReason = event.reason;
                streamErrorKind = (event as unknown as { error?: { kind?: ApplicationErrorKind } }).error?.kind ?? null;
                streamErrorMessage = (event as unknown as { error?: { message?: string } }).error?.message ?? null;
                streamErrorUpstream = (event as unknown as { error?: { upstream?: UpstreamFailureSummary | null } }).error?.upstream ?? null;
              }
              yield event;
            }
            if (terminalReason !== null && terminalReason !== "error") {
              try {
                await reportRouteSuccess();
              } catch {}
            }
          } finally {
            const finalUsage = observedUsage;
            const isClientAborted = input.request.signal.aborted || streamErrorKind === "client_aborted";
            const finalAdmission = finalUsage === null ? { inputTokens: admissionEstimate, outputTokens: 0 } : { inputTokens: admissionInputTokens(finalUsage, admissionEstimate), outputTokens: (finalUsage as unknown as { outputTokens?: number })?.outputTokens ?? finalUsage.completionTokens ?? 0 };
            settleAdmission(finalAdmission as unknown as AdmissionUsage);
            decrementInFlight();
            emitRequestLog({
              event: isClientAborted ? "aborted" : "complete",
              requestId,
              endpoint: input.request.endpoint,
              providerId: providerId(),
              errorKind: isClientAborted ? "client_aborted" : streamErrorKind,
              model: normalizedRequest?.model ?? null,
              status: isClientAborted ? 499 : responseStatus,
              durationMs: Math.max(0, performance.now() - startedAt),
              inputTokens: (finalUsage as unknown as { inputTokens?: number | null })?.inputTokens ?? finalUsage?.promptTokens ?? null,
              outputTokens: (finalUsage as unknown as { outputTokens?: number | null })?.outputTokens ?? finalUsage?.completionTokens ?? null,
              cachedTokens: (finalUsage as unknown as { cacheReadTokens?: number | null })?.cacheReadTokens ?? finalUsage?.cachedTokens ?? null,
              cacheWriteTokens: (finalUsage as unknown as { cacheWriteTokens?: number | null })?.cacheWriteTokens ?? null,
              messageCount: normalizedRequest?.messages.length ?? 0,
              toolCount: normalizedRequest?.tools.length ?? 0,
              clientName: client.name,
              clientSource: client.source,
              clientIp: input.request.clientIp ?? null,
              ...currentSelection(),
              reasoningTokens: finalUsage?.reasoningTokens ?? null,
            });
            if (capture !== null) {
              (capture as unknown as { response: (v: unknown) => void }).response({ mode: "stream", events: clientStreamEvents });
            }
            await (telemetry as unknown as TelemetryStartHandle).finish({
              statusCode: isClientAborted ? 0 : responseStatus ?? 200,
              errorKind: isClientAborted ? null : streamErrorKind,
              errorProviderCode: streamErrorUpstream?.providerCode ?? null,
              errorProviderType: streamErrorUpstream?.providerType ?? null,
              errorUpstreamRequestId: streamErrorUpstream?.requestId ?? null,
              errorRetryAfterMs: streamErrorUpstream?.retryAfterMs ?? null,
              usage: finalUsage,
              providerId: providerId(),
              model: normalizedRequest?.model ?? null,
              mode: "stream",
              messageCount: normalizedRequest?.messages.length ?? 0,
              toolCount: normalizedRequest?.tools.length ?? 0,
              imageCount: normalizedRequest?.images.length ?? 0,
              routing: routeMetadata(streamErrorMessage),
              ...currentSelection(),
              reasoningTokens: finalUsage?.reasoningTokens ?? null,
            });
          }
        })(),
      } as unknown as ProviderOutput;
    }
    let response = writeResponse(presentedOutput as unknown as Parameters<typeof writeResponse>[0], requestId);
    if (response.body.mode === "stream") {
      response = {
        ...response,
        body: { ...response.body, model: normalizedRequest.model },
      };
    }
    responseStatus = (response as unknown as { status: number }).status;
    if ((output as unknown as ProviderOutput).mode === "non_stream") {
      const usage = (output as unknown as ProviderOutput).usage;
      emitRequestLog({
        event: "complete",
        requestId,
        endpoint: input.request.endpoint,
        providerId: providerId(),
        model: normalizedRequest.model,
        status: (response as unknown as { status: number }).status,
        errorKind: null,
        durationMs: Math.max(0, performance.now() - startedAt),
        inputTokens: (usage as unknown as { inputTokens?: number | null })?.inputTokens ?? usage?.promptTokens ?? null,
        outputTokens: (usage as unknown as { outputTokens?: number | null })?.outputTokens ?? usage?.completionTokens ?? null,
        cachedTokens: (usage as unknown as { cacheReadTokens?: number | null })?.cacheReadTokens ?? usage?.cachedTokens ?? null,
        cacheWriteTokens: (usage as unknown as { cacheWriteTokens?: number | null })?.cacheWriteTokens ?? null,
        messageCount: normalizedRequest.messages.length,
        toolCount: normalizedRequest.tools.length,
        clientName: client.name,
        clientSource: client.source,
        clientIp: input.request.clientIp ?? null,
        ...currentSelection(),
        reasoningTokens: (usage as unknown as { reasoningTokens?: number | null })?.reasoningTokens ?? null,
      });
    }
    if ((output as unknown as ProviderOutput).mode === "non_stream") {
      (telemetry as unknown as TelemetryStartHandle).recordFirstByte?.();
      (capture as unknown as { response: (v: unknown) => void })?.response((response as unknown as { body: { mode: string; value: unknown } }).body.mode === "json" ? (response as unknown as { body: { value: unknown } }).body.value : null);
      await (capture as unknown as { settle: () => Promise<void> })?.settle();
      await (telemetry as unknown as TelemetryStartHandle).finish({
        statusCode: (response as unknown as { status: number }).status,
        errorKind: null,
        usage: (output as unknown as { usage?: ProviderUsage | null }).usage ?? null,
        providerId: providerId(),
        model: normalizedRequest.model,
        mode: (output as unknown as { mode: string }).mode,
        messageCount: normalizedRequest.messages.length,
        toolCount: normalizedRequest.tools.length,
        imageCount: normalizedRequest.images.length,
        routing: routeMetadata(),
        ...currentSelection(),
        reasoningTokens: (output as unknown as { usage?: ProviderUsage | null }).usage?.reasoningTokens ?? null,
      });
      await reportRouteSuccess();
    }
    streamHandedOff = (output as unknown as { mode: string }).mode === "stream";
    return response as unknown as PresentedProxyResponse;
  } catch (error) {
    settleAdmission(null);
    const failure = normalizeProviderError(error);
    const response = writeErrorResponse(failure as unknown as Parameters<typeof writeErrorResponse>[0], requestId);
    const isClientAborted = failure.kind === "client_aborted";
    emitRequestLog({
      event: isClientAborted ? "aborted" : "failed",
      requestId,
      endpoint: input.request.endpoint,
      providerId: resolvedPlan?.candidates[0]?.providerId ?? null,
      model: normalizedRequest?.model ?? null,
      status: (response as unknown as { status: number }).status,
      errorKind: (failure as unknown as { kind: ApplicationErrorKind }).kind,
      durationMs: Math.max(0, performance.now() - startedAt),
      inputTokens: admissionEstimate,
      outputTokens: 0,
      cachedTokens: null,
      cacheWriteTokens: null,
      messageCount: normalizedRequest?.messages.length ?? 0,
      toolCount: normalizedRequest?.tools.length ?? 0,
      clientName: client.name,
      clientSource: client.source,
      clientIp: input.request.clientIp ?? null,
      ...currentSelection(),
      reasoningTokens: null,
    });
    const telemetryStatus = isClientAborted ? 0 : (response as unknown as { status: number }).status;
    const telemetryErrorKind = isClientAborted ? null : (failure as unknown as { kind: ApplicationErrorKind }).kind;
    const failureUsage: ProviderUsage = {
      promptTokens: admissionEstimate,
      completionTokens: 0,
      totalTokens: admissionEstimate,
      inputTokens: admissionEstimate,
      outputTokens: 0,
      source: "tokenizer",
    };
    (capture as unknown as { response: (v: unknown) => void })?.response((response as unknown as { body: { mode: string; value: unknown } }).body.mode === "json" ? (response as unknown as { body: { value: unknown } }).body.value : null);
    await (capture as unknown as { settle: () => Promise<void> })?.settle();
    await (telemetry as unknown as TelemetryStartHandle).finish({
      statusCode: telemetryStatus,
      errorKind: telemetryErrorKind,
      errorProviderCode: (failure as unknown as { upstream?: { providerCode?: string | null } | null }).upstream?.providerCode ?? null,
      errorProviderType: (failure as unknown as { upstream?: { providerType?: string | null } | null }).upstream?.providerType ?? null,
      errorUpstreamRequestId: (failure as unknown as { upstream?: { requestId?: string | null } | null }).upstream?.requestId ?? null,
      errorRetryAfterMs: (failure as unknown as { upstream?: { retryAfterMs?: number | null } | null }).upstream?.retryAfterMs ?? null,
      usage: failureUsage,
      providerId: resolvedPlan?.candidates[0]?.providerId ?? null,
      model: normalizedRequest?.model ?? null,
      mode: normalizedRequest?.stream ? "stream" : null,
      messageCount: normalizedRequest?.messages.length ?? 0,
      toolCount: normalizedRequest?.tools.length ?? 0,
      imageCount: normalizedRequest?.images.length ?? 0,
      routing: routeMetadata((failure as unknown as { upstream?: { providerCode?: string | null } | null; safeMessage: string }).upstream?.providerCode ?? (failure as unknown as { safeMessage: string }).safeMessage),
      ...currentSelection(),
      reasoningTokens: null,
    });
    await cleanup.run();
    return response as unknown as PresentedProxyResponse;
  } finally {
    if (!streamHandedOff) decrementInFlight();
  }
}

// Re-export new types for callers that import from ./types directly via request path
export type { AffinityKey, LeaseHandle } from "../types/routing.js";
export type { TelemetryEvent, TelemetryPort, ProviderUsage } from "../types/telemetry.js";
export type { StreamEvent } from "../types/stream.js";
export type { RoutingSnapshot } from "../types/routing.js";

/**
 * Single live proxy path — delegates to runProxyRequest for full opencodeft/muse handling
 * Handles both AuthorizedProxyRequestInput (from api/v1) and legacy proxy-port input shape
 */
