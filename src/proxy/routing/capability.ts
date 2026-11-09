import type { NormalizedTool } from "../types/content.js";
import type { WebSearchPreference } from "../types/provider.js";
import type { ProxyRequest } from "../types/request.js";
import type { RequiredRouteCapabilities, WebSearchRouteKind } from "../types/routing.js";

/** Ordered provider kinds used when resolving hosted web-search requests. */
export const WEB_SEARCH_ROUTE_ORDER: readonly WebSearchRouteKind[] = ["native", "codex", "antigravity", "exa"];

/** Human-readable labels for hosted web-search route kinds. */
export const WEB_SEARCH_ROUTE_LABELS: Readonly<Record<WebSearchRouteKind, string>> = {
  native: "Native search",
  codex: "Codex",
  antigravity: "Antigravity",
  exa: "Exa",
  passthrough: "Original route passthrough",
};

/** A selectable web-search routing preference. */
export interface WebSearchPreferenceOption {
  readonly value: WebSearchPreference;
  readonly label: string;
}

/** Supported persisted web-search routing preferences. */
export const WEB_SEARCH_PREFERENCE_OPTIONS: readonly WebSearchPreferenceOption[] = [
  { value: "auto", label: "Automatic" },
  { value: "prefer-codex", label: "Prefer Codex" },
  { value: "prefer-exa", label: "Prefer Exa" },
];

/** Narrows a persisted web-search preference. */
export function isWebSearchPreference(value: unknown): value is WebSearchPreference {
  return value === "auto" || value === "prefer-codex" || value === "prefer-exa";
}

/** Returns a valid persisted web-search preference. */
export function normalizeWebSearchPreference(value: unknown): WebSearchPreference {
  return isWebSearchPreference(value) ? value : "auto";
}

/** Narrows a web-search route kind. */
export function isWebSearchRouteKind(value: unknown): value is WebSearchRouteKind {
  return value === "native" || value === "codex" || value === "antigravity" || value === "exa" || value === "passthrough";
}

/** Returns deterministic route preference order. */
export function webSearchPreferenceOrder(preference: WebSearchPreference): readonly WebSearchRouteKind[] {
  if (preference === "prefer-codex") return ["codex", "native", "antigravity", "exa"];
  if (preference === "prefer-exa") return ["exa", "native", "codex", "antigravity"];
  return WEB_SEARCH_ROUTE_ORDER;
}

/** Returns whether a normalized tool requests hosted web-search execution. */
export function isWebSearchTool(tool: NormalizedTool): boolean {
  return tool.kind === "hosted" && tool.hostedType === "web_search";
}

/** Capability fields recognized for hosted web-search routing. */
export interface WebSearchCapabilityInput {
  readonly search?: boolean;
  readonly websearch?: boolean;
  readonly surfaces?: readonly string[];
}

/** Returns whether provider or model capabilities support hosted web search. */
export function hasWebSearchCapability(value: WebSearchCapabilityInput | null | undefined): boolean {
  return value?.search === true || value?.websearch === true || value?.surfaces?.includes("web-search") === true;
}

/** Derives immutable pre-lease requirements from a canonical proxy request. */
export function deriveRequiredCapabilities(request: ProxyRequest): RequiredRouteCapabilities {
  return {
    tools: request.tools.length > 0,
    hostedSearch: request.tools.some(isWebSearchTool),
    reasoning: request.reasoning === "enabled" || request.reasoningConfig !== undefined,
    image: request.messages.some((message) => message.content.some((block) => block.type === "image")),
    pdf: request.messages.some((message) => message.content.some((block) => block.type === "pdf")),
    video: request.messages.some((message) => message.content.some((block) => block.type === "video")),
    responseFormat: (() => { const _f = (request as unknown as { responseFormat?: unknown }).responseFormat; return (typeof _f === "string" ? _f : (_f != null && typeof _f === "object" && "kind" in (_f as Record<string, unknown>) ? String((_f as Record<string, unknown>)["kind"]) : "text")) as "text" | "json_object" | "json_schema"; })(),
    stream: request.stream,
    sourceSurface: request.sourceSurface,
  };
}
