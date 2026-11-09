/**
 * Request domain — ProxyRequest, ProviderRequest, Adapter, RunProxyRequestInput, ClientIdentity, NetworkSelection
 * Manual write
 */

import type { ProxyOperation, Surface } from "./surface.js";
import type { ContentPart, NormalizedMessage, NormalizedTool, RequestLimits, AnthropicRequestOptions, ReasoningConfig, ImageReference } from "./content.js";
import type { ProviderMeta, ProviderCaps, ProviderEndpoint, ProviderModelCatalog, ProviderModel } from "./provider.js";
import type { RouteTarget, RoutingSnapshot, LeaseHandle, CommitGate, ProxyEndpoint, RouteSwitch, RouteHealthStore } from "./routing.js";
import type { InternalFailure } from "./error-types.js";
import type { StreamEvent } from "./stream.js";
import type { ProviderUsage, ProviderResponseMetadata, PayloadCapture, TranslationDiagnostic } from "./telemetry.js";
import type { PublicErrorBody } from "./error-types.js";

/** Canonical policy for automatic, forbidden, required, or named function tool calls. */
export type ToolChoice =
  | { readonly kind: "auto" | "none" | "required" }
  | { readonly kind: "function"; readonly name: string };

/** Canonical structured-output constraint accepted by every normalized request surface. */
export type ResponseFormatConstraint =
  | { readonly kind: "text" }
  | { readonly kind: "json_object" }
  | { readonly kind: "json_schema"; readonly schema: Readonly<Record<string, unknown>> };

export interface NetworkSelection {
  readonly proxyId?: string | null;
  readonly url?: string | null;
  readonly isRelay?: boolean;
  readonly relaySecret?: string | null;
  readonly release?: () => Promise<void>;
}

export interface ProviderRequest {
  readonly target: RouteTarget & { readonly surface: Surface; readonly upstreamModelId: string };
  readonly request: ProxyRequest;
  readonly credential: string;
  readonly network: NetworkSelection;
  readonly signal: AbortSignal;
  readonly headers?: Headers;
  readonly capture?: PayloadCapture;
  readonly recordDiagnostic?: (diagnostic: TranslationDiagnostic) => void;
  readonly endpoint?: ProviderEndpoint | null;
}

export interface PassthroughProviderRequest {
  readonly target: RouteTarget & { readonly surface: Surface; readonly upstreamModelId: string };
  readonly path: string;
  readonly body: Readonly<Record<string, unknown>>;
  readonly credential: string;
  readonly network: NetworkSelection;
  readonly signal: AbortSignal;
  readonly headers: Headers;
  readonly stream: boolean;
  readonly limits: RequestLimits;
}

export interface PassthroughProviderResponse {
  readonly response: Response;
  readonly release: () => Promise<void>;
}

export type ProviderOutput =
  | { readonly mode: "non_stream"; readonly body: Readonly<Record<string, unknown>>; readonly usage?: ProviderUsage; readonly metadata?: ProviderResponseMetadata }
  | { readonly mode: "stream"; readonly events: AsyncIterable<StreamEvent>; readonly usage?: ProviderUsage; readonly metadata?: ProviderResponseMetadata };

export interface ProxyRequest {
  readonly model: string;
  readonly operation?: ProxyOperation;
  readonly messages: readonly NormalizedMessage[];
  readonly tools: readonly NormalizedTool[];
  readonly stream: boolean;
  readonly responseFormat: ResponseFormatConstraint | "text" | "json_object" | "json_schema";
  readonly responseFormatSchema?: Readonly<Record<string, unknown>>;
  readonly temperature?: number;
  readonly topP?: number;
  readonly frequencyPenalty?: number;
  readonly presencePenalty?: number;
  readonly seed?: number;
  readonly user?: string;
  readonly verbosity?: string;
  readonly stop?: readonly string[];
  readonly parallelToolCalls?: boolean;
  readonly toolChoice?: ToolChoice;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly reasoning: "enabled" | "disabled" | "default";
  readonly reasoningConfig?: ReasoningConfig;
  readonly include?: readonly string[];
  readonly contextManagement?: Readonly<Record<string, unknown>> | readonly Readonly<Record<string, unknown>>[];
  readonly mcpServers?: readonly Readonly<Record<string, unknown>>[];
  readonly maxOutputTokens: number | null;
  readonly sourceSurface: Surface;
  readonly signal: AbortSignal;
  readonly limits: RequestLimits;
  readonly cacheKey?: string;
  readonly sessionId?: string;
  readonly conversationId?: string;
  readonly cacheIntent?: unknown;
  readonly metadataUserId?: string;
  readonly anthropic?: AnthropicRequestOptions;
  readonly images: readonly ImageReference[];
  readonly wirePayload?: Readonly<Record<string, unknown>>;
  readonly systemPromptState?: unknown;
  readonly nativeMetadata?: Readonly<Record<string, unknown>>;
}

export interface Adapter {
  readonly metadata: ProviderMeta;
  readonly capabilities: ProviderCaps;
  readonly models: ProviderModelCatalog;
  resolveTarget(modelId: string, surface: Surface): RouteTarget;
  call(input: ProviderRequest): Promise<ProviderOutput>;
  callPassthrough?(input: PassthroughProviderRequest): Promise<PassthroughProviderResponse>;
  mapError(error: unknown): InternalFailure;
  /**
   * Inbuilt model discovery — adapter-owned, no central kind.
   * Returns `null` to keep static fallback, `[]` when endpoint replied empty.
   */
  discoverModels?: (input: DiscoveryInput) => Promise<readonly ProviderModel[] | null>;
  endpointCandidates?: (target: RouteTarget) => readonly ProviderEndpoint[];
}

export interface DiscoveryInput {
  readonly credential: string | null;
  readonly signal?: AbortSignal;
}

export type ClientName =
  | "github_copilot"
  | "claude_code"
  | "codex"
  | "cursor"
  | "cline"
  | "opencode"
  | "gemini_cli"
  | "pi"
  | "unknown";

export type ClientDetectionSource =
  | "explicit_header"
  | "user_agent"
  | "protocol_header"
  | "body_shape"
  | "endpoint"
  | "prompt_marker"
  | "unknown";

export interface ClientIdentity {
  readonly name: ClientName;
  readonly source: ClientDetectionSource;
  readonly rawUserAgent?: string;
}

export interface RunProxyRequestInput {
  readonly requestId?: string;
  readonly endpoint: ProxyEndpoint;
  readonly surface: Surface;
  readonly headers: Headers;
  readonly body: unknown;
  readonly signal: AbortSignal;
  readonly clientIp?: string | null;
}

/** Single ingress computation — requestId, detection, identity, endpoint, auth. */
export interface ProxyIngressContext {
  readonly requestId: string;
  readonly detection: import("../normalize/detection.js").FormatDetectionResult;
  readonly client: ClientIdentity;
  readonly normalizedEndpoint: ProxyEndpoint;
  readonly normalizedSurface: Surface;
  readonly apiKeyId: string | null;
  readonly disableRemoteMapping: boolean;
}

export function detectClient(headers: Headers, normalized?: ProxyRequest): ClientIdentity {
  const explicit = headers.get("x-client-name")?.trim().toLowerCase();
  if (explicit === "github_copilot") return { name: "github_copilot", source: "explicit_header" };
  if (explicit === "claude_code") return { name: "claude_code", source: "explicit_header" };
  if (explicit === "codex") return { name: "codex", source: "explicit_header" };
  const userAgent = headers.get("user-agent")?.toLowerCase() ?? "";
  if (userAgent.includes("claude-cli")) return { name: "claude_code", source: "user_agent" };
  if (userAgent.includes("codex")) return { name: "codex", source: "user_agent" };
  return { name: "unknown", source: "unknown" };
}

export interface StreamLifecycle {
  readonly headersCommitted: boolean;
  readonly meaningfulOutput: boolean;
  readonly terminalSeen: boolean;
  readonly close: () => Promise<void>;
}

export interface PresentedProxyResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly body: ResponseBody;
}

export type ResponseBody =
  | { readonly mode: "json"; readonly value: Record<string, unknown> | PublicErrorBody }
  | { readonly mode: "stream"; readonly events: AsyncIterable<StreamEvent>; readonly model?: string };


