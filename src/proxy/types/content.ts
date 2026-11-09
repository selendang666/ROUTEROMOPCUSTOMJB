/**
 * Content domain — multimodal content + normalized message + request limits
 */

import type { ReasoningEffort, ReasoningSummary, ReasoningMode, ReasoningContext } from "./surface.js";

export interface ImageReference {
  readonly kind: "url" | "data" | "file";
  readonly value: string;
  readonly mediaType: string | null;
  readonly transformations?: Readonly<Record<string, "downsize" | "error">>;
}

export interface PdfReference {
  readonly kind: "url" | "data" | "file";
  readonly value: string;
  readonly mediaType: string | null;
  readonly filename?: string | null;
  readonly title?: string | null;
  readonly context?: string | null;
  readonly citations?: Readonly<Record<string, unknown>>;
  readonly contentBlocks?: readonly Readonly<Record<string, unknown>>[];
}

export interface VideoReference {
  readonly kind: "url" | "data" | "file";
  readonly value: string;
  readonly mediaType: string | null;
  readonly filename?: string | null;
}

interface ContentPartFields {
  readonly text?: string;
  readonly image?: ImageReference;
  readonly pdf?: PdfReference;
  readonly video?: VideoReference;
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly toolArguments?: string;
  readonly toolResultIsError?: boolean;
  readonly isError?: boolean;
  readonly reasoningText?: string;
  readonly reasoningSignature?: string;
  readonly reasoningEncryptedContent?: string;
  readonly reasoningSummary?: readonly Readonly<Record<string, unknown>>[];
  readonly reasoningSourceSurface?: "openai-responses" | "anthropic-messages" | "gemini";
  readonly nativeType?: string;
  readonly nativePayload?: Readonly<Record<string, unknown>>;
  readonly raw?: Readonly<Record<string, unknown>>;
  readonly cacheControl?: "ephemeral" | { readonly type: "ephemeral"; readonly ttl?: "5m" | "1h" };
  readonly citations?: readonly Readonly<Record<string, unknown>>[];
}

export type ContentPart =
  | (ContentPartFields & { readonly type: "text"; readonly text: string })
  | (ContentPartFields & { readonly type: "image"; readonly image: ImageReference })
  | (ContentPartFields & { readonly type: "pdf"; readonly pdf: PdfReference })
  | (ContentPartFields & { readonly type: "video"; readonly video: VideoReference })
  | (ContentPartFields & { readonly type: "tool_use"; readonly toolCallId: string; readonly toolName: string; readonly toolArguments: string })
  | (ContentPartFields & { readonly type: "tool_result"; readonly toolCallId: string; readonly text?: string })
  | (ContentPartFields & { readonly type: "reasoning"; readonly reasoningText: string })
  | (ContentPartFields & { readonly type: "compaction"; readonly text: string })
  | (ContentPartFields & { readonly type: "native"; readonly nativeType: string; readonly nativePayload: Readonly<Record<string, unknown>> })
  | (ContentPartFields & { readonly type: "unknown"; readonly raw?: Readonly<Record<string, unknown>> });

/** Normalized message preserved in ProxyRequest — system/developer order is authoritative. */
export interface NormalizedMessage {
  readonly role: "system" | "developer" | "user" | "assistant" | "tool";
  readonly content: readonly ContentPart[];
  readonly phase?: "commentary" | "final_answer";
  readonly cacheControl?: "ephemeral" | { readonly type: "ephemeral"; readonly ttl?: "5m" | "1h" };
}

interface NormalizedToolFields {
  readonly raw?: Readonly<Record<string, unknown>>;
  readonly nativeOptions?: Readonly<Record<string, unknown>>;
  readonly deferLoading?: boolean;
  readonly allowedCallers?: readonly string[];
  readonly inputExamples?: readonly Readonly<Record<string, unknown>>[];
}

/** A caller-defined function tool that can be projected to function-tool wires. */
export interface NormalizedFunctionTool extends NormalizedToolFields {
  readonly kind: "function";
  readonly name: string;
  readonly description: string | null;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly strict?: boolean;
  readonly schemaJsonLength?: number;
}

/** A first-class hosted web tool, distinct from user-defined functions of the same name. */
export interface NormalizedHostedTool extends NormalizedToolFields {
  readonly kind: "hosted";
  readonly hostedType: "web_search" | "web_fetch";
}

/** A provider-native tool whose wire type is understood by Oh My Omop - Router. */
export interface NormalizedNativeTool extends NormalizedToolFields {
  readonly kind: "native";
  readonly nativeType: string;
}

/** An otherwise-valid provider-native tool retained for same-surface passthrough only. */
export interface NormalizedOpaqueTool extends NormalizedToolFields {
  readonly kind: "opaque";
  readonly nativeType: string;
  readonly raw: Readonly<Record<string, unknown>>;
}

/** Canonical tool declaration retaining semantic identity without name inference. */
export type NormalizedTool =
  | NormalizedFunctionTool
  | NormalizedHostedTool
  | NormalizedNativeTool
  | NormalizedOpaqueTool;

export interface RequestLimits {
  readonly maxBodyBytes: number;
  readonly connectTimeoutMs: number;
  readonly firstByteTimeoutMs: number;
  readonly idleTimeoutMs: number;
  readonly totalTimeoutMs: number;
}

export interface CacheIntent {
  readonly key: string | null;
  readonly stablePrefixFingerprint: string | null;
  readonly affinityKey: string | null;
  readonly policy: "automatic" | "explicit" | "ephemeral";
  readonly ttl: string | null;
}

export interface SystemPromptState {
  readonly clientSystemBlocks: readonly ContentPart[];
  readonly clientDeveloperBlocks: readonly ContentPart[];
  readonly ponytailBlocks: readonly ContentPart[];
  readonly ponytailApplied: boolean;
  readonly placement: "system" | "developer" | "prepend_user";
}

export interface PonytailPolicy {
  readonly enabled: boolean;
  readonly systemPrompt: string;
}

export interface RtkConfig {
  readonly enabled: boolean;
  readonly quality: "low" | "medium" | "high";
  readonly emergencyThresholdTokens: number;
  readonly preserveRecentTurns: number;
}

export interface ReasoningConfig {
  readonly effort?: ReasoningEffort;
  readonly summary?: ReasoningSummary;
  readonly mode?: ReasoningMode;
  readonly context?: ReasoningContext;
  readonly exclude?: boolean;
  readonly enabled?: boolean;
  readonly maxTokens?: number;
}

export interface AnthropicRequestOptions {
  readonly speed?: "fast" | "standard";
  readonly inferenceGeo?: "us" | "global";
  readonly taskBudgetTokens?: number;
  readonly structuredOutputMode?: "output_format" | "json_tool" | "auto";
  readonly disableParallelToolUse?: boolean;
}

/** Canonical compatibility name for normalized multimodal content. */
export type ContentBlock = ContentPart;
