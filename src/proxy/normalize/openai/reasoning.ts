import type { ReasoningConfig } from "../../types/content.js";
import type { ReasoningContext, ReasoningEffort, ReasoningMode, ReasoningSummary } from "../../types/surface.js";
import { MAX_OUTPUT_TOKENS, narrowNumber } from "../../validation.js";
import { isProtocolError, protocolError } from "../../errors.js";
import type { ProtocolError } from "../../errors.js";
import { normalizeClientEffort } from "../../translate/policy.js";

export const REASONING_EFFORTS: readonly string[] = ["xhigh", "high", "medium", "low", "minimal", "none"];

/** Summary verbosity accepted by `reasoning.summary`. Shared with the Chat codec. */
export const REASONING_SUMMARIES: readonly string[] = ["auto", "concise", "detailed"];

/** Execution modes accepted by the Responses `reasoning.mode` field. */
export const REASONING_MODES: readonly string[] = ["standard", "pro"];

/** History context values accepted by the Responses `reasoning.context` field. */
export const REASONING_CONTEXTS: readonly string[] = ["auto", "current_turn", "all_turns"];

/**
 * Parses a `reasoning` wire object (as seen on both the Responses and Chat
 * surfaces) into a structured {@link ReasoningConfig} plus a flat enable flag.
 * Field-level validation errors surface as a {@link ProtocolError}.
 *
 * @param obj - the already-narrowed `reasoning` object
 * @param fieldPrefix - prefix for error field names (e.g. "reasoning")
 * @param enabledValue - the `enabled` value read from the object, if any
 * @returns the parsed config (possibly undefined when empty) and flag, or a ProtocolError
 */
export function parseReasoningConfig(
  obj: Record<string, unknown>,
  fieldPrefix: string,
  enabledValue: unknown,
): { flag: "enabled" | "disabled" | "default"; config: ReasoningConfig | undefined } | ProtocolError {
  if (enabledValue === false) return { flag: "disabled", config: { enabled: false } };
  const config: { effort?: ReasoningEffort; maxTokens?: number; exclude?: boolean; enabled?: boolean; summary?: ReasoningSummary; mode?: ReasoningMode; context?: ReasoningContext } = {};
  const effortRaw = obj["effort"];
  if (effortRaw !== undefined && effortRaw !== null && effortRaw !== "") {
    const effort = normalizeClientEffort(effortRaw);
    if (effort !== undefined) config.effort = effort;
  }
  const summaryRaw = obj["summary"];
  if (summaryRaw !== undefined && summaryRaw !== null) {
    if (typeof summaryRaw !== "string") return protocolError(`${fieldPrefix}.summary`, `${fieldPrefix}.summary: expected a string`);
    const summary = REASONING_SUMMARIES.includes(summaryRaw as ReasoningSummary) ? (summaryRaw as ReasoningSummary) : null;
    if (summary === null) return protocolError(`${fieldPrefix}.summary`, `${fieldPrefix}.summary: unsupported value "${summaryRaw}"`);
    config.summary = summary;
  }
  const modeRaw = obj["mode"];
  if (modeRaw !== undefined && modeRaw !== null) {
    if (typeof modeRaw !== "string") return protocolError(`${fieldPrefix}.mode`, `${fieldPrefix}.mode: expected a string`);
    const mode = REASONING_MODES.includes(modeRaw as ReasoningMode) ? (modeRaw as ReasoningMode) : null;
    if (mode === null) return protocolError(`${fieldPrefix}.mode`, `${fieldPrefix}.mode: unsupported value "${modeRaw}"`);
    config.mode = mode;
  }
  const contextRaw = obj["context"];
  if (contextRaw !== undefined && contextRaw !== null) {
    if (typeof contextRaw !== "string") return protocolError(`${fieldPrefix}.context`, `${fieldPrefix}.context: expected a string`);
    const context = REASONING_CONTEXTS.includes(contextRaw as ReasoningContext) ? (contextRaw as ReasoningContext) : null;
    if (context === null) return protocolError(`${fieldPrefix}.context`, `${fieldPrefix}.context: unsupported value "${contextRaw}"`);
    config.context = context;
  }
  const maxTokensRaw = obj["max_tokens"];
  if (maxTokensRaw !== undefined && maxTokensRaw !== null) {
    const maxTokens = narrowNumber(maxTokensRaw, `${fieldPrefix}.max_tokens`, { integer: true, min: 0, max: MAX_OUTPUT_TOKENS });
    if (isProtocolError(maxTokens)) return maxTokens;
    config.maxTokens = maxTokens;
  }
  if (typeof obj["exclude"] === "boolean") config.exclude = obj["exclude"];
  if (enabledValue === true) config.enabled = true;
  const flag = config.effort !== undefined || config.enabled === true || config.maxTokens !== undefined || config.mode !== undefined || config.context !== undefined ? "enabled" : "default";
  return { flag, config: Object.keys(config).length > 0 ? config : undefined };
}
