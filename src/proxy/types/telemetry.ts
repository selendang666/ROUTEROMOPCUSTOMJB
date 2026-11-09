/**
 * Telemetry domain — TelemetryEvent, TelemetryPort, PayloadCapture, ProviderUsage
 * Manual write
 */

export interface ProviderUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  readonly cachedTokens?: number;
  readonly reasoningTokens?: number | null;
  readonly acceptedPredictionTokens?: number | null;
  readonly rejectedPredictionTokens?: number | null;
  readonly inputTokens?: number | null;
  readonly outputTokens?: number | null;
  readonly cacheReadTokens?: number | null;
  readonly cacheWriteTokens?: number | null;
  readonly source?: "provider" | "tokenizer" | "unknown";
}

export interface ProviderResponseMetadata {
  readonly requestId?: string;
  readonly systemFingerprint?: string;
  readonly serviceTier?: string;
  readonly model?: string;
}

export interface TelemetryEvent {
  readonly requestId: string;
  readonly endpoint?: string;
  readonly surface?: string;
  readonly model: string;
  readonly providerId: string | null;
  readonly apiKeyId?: string | null;
  readonly apiKeyPrefix?: string | null;
  readonly clientIp?: string | null;
  readonly clientName?: string;
  readonly clientSource?: string;
  readonly userAgent?: string | null;
  readonly fingerprint?: string | null;
  readonly method?: string;
  readonly path?: string;
  readonly safeHeaders?: Readonly<Record<string, string>>;
  readonly statusCode: number | null;
  readonly errorKind: string | null;
  readonly errorProviderCode?: string | null;
  readonly errorProviderType?: string | null;
  readonly errorUpstreamRequestId?: string | null;
  readonly errorRetryAfterMs?: number | null;
  readonly durationMs: number | null;
  readonly usage: ProviderUsage | null;
  readonly committed: boolean;
  readonly dropped?: boolean;
  readonly degraded?: boolean;
  readonly overhead?: import("../../runtime/overhead.js").OverheadReport;
  readonly tffbMs?: number | null;
  readonly tfftMs?: number | null;
  readonly messageCount?: number | null;
  readonly toolCount?: number | null;
  readonly imageCount?: number | null;
  readonly startedAt?: string | null;
  readonly finishedAt?: string | null;
  readonly accountId?: string | null;
  readonly proxyId?: string | null;
  readonly reasoningTokens?: number | null;
}

export interface TelemetryPort {
  enqueue(event: TelemetryEvent): { enqueued: boolean; dropped: boolean; degraded: boolean };
}

export interface PayloadCapture {
  request(value: unknown): void;
  response(value: unknown): void;
  observeResponse(response: Response): Response;
  settle(): Promise<void>;
}

export interface RequestTelemetry {
  readonly requestId: string;
  readonly endpoint: string;
  readonly surface: string;
  readonly apiKeyId: string | null;
  readonly apiKeyPrefix: string | null;
  readonly clientIp?: string | null;
  readonly clientName: string;
  readonly clientSource: string;
  readonly providerId: string | null;
  readonly model: string | null;
  readonly mode: "non_stream" | "stream" | null;
  readonly statusCode: number | null;
  readonly errorKind: string | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly durationMs: number | null;
  readonly usage: ProviderUsage | null;
  readonly messageCount: number;
  readonly toolCount: number;
  readonly imageCount: number;
  readonly switches: readonly unknown[];
}

export interface TelemetryFinish {
  readonly statusCode: number;
  readonly errorKind: string | null;
  readonly usage: ProviderUsage | null;
  readonly providerId: string | null;
  readonly model: string | null;
  readonly mode: "non_stream" | "stream" | null;
  readonly messageCount: number;
  readonly toolCount: number;
  readonly imageCount: number;
  readonly routing?: unknown;
}

export interface TelemetryWriter {
  start(input: Omit<RequestTelemetry, "finishedAt" | "durationMs" | "statusCode" | "errorKind" | "usage" | "providerId" | "model" | "mode" | "switches">): unknown;
}

export interface WebSearchFallback {
  readonly previousRouteId: string;
  readonly replacementRouteId: string | null;
  readonly reason: string;
}

export type TranslationDiagnosticStage = "detection" | "normalization" | "request" | "response" | "policy" | "stream";
export type TranslationDiagnosticAction = "preserved" | "adapted" | "dropped" | "rejected" | "fallback";

export interface TranslationDiagnostic {
  readonly stage: TranslationDiagnosticStage;
  readonly sourceFormat: string;
  readonly targetSurface: string;
  readonly fieldCategory: string;
  readonly action: TranslationDiagnosticAction;
  readonly reason: string;
}

export interface RequestRoutingMetadata {
  readonly requestedModel: string | null;
  readonly mappedModel: string | null;
  readonly upstreamModel: string | null;
  readonly wireSurface: string | null;
  readonly errorMessage: string | null;
  readonly cacheKeyPresent?: boolean;
  readonly cacheBreakpointPresent?: boolean;
  readonly webSearchRoute?: string;
  readonly webSearchPassthrough?: boolean;
  readonly webSearchFallbacks?: readonly WebSearchFallback[];
  readonly translationDiagnostics?: readonly TranslationDiagnostic[];
  readonly nativePassthrough?: boolean;
  readonly contextWindowTokens?: number | null;
  readonly estimatedInputTokens?: number | null;
  readonly contextUsageRatio?: number | null;
  readonly hedgeLegs?: number;
  readonly hedgeWinnerCandidateId?: string | null;
}
