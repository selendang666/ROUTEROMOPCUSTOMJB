/** Stop reason maps — single owner for stream codec. */

/** OpenAI finish_reason → canonical stop. */
export const OPENAI_STOP_MAP = {
  stop: "stop",
  length: "length",
  tool_calls: "tool_calls",
  content_filter: "content_filter",
} as const;

/** Anthropic stop_reason → canonical stop. */
export const ANTHROPIC_STOP_MAP = {
  end_turn: "stop",
  max_tokens: "length",
  tool_use: "tool_calls",
  stop_sequence: "stop",
  pause_turn: "pause",
} as const;

/** Responses status → canonical. */
export const RESPONSE_STATUS_MAP = {
  completed: "completed",
  incomplete: "incomplete",
  failed: "failed",
} as const;

export interface ProviderUsageRaw {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly cachedTokens?: number;
  readonly reasoningTokens?: number;
}

export interface ProviderUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  readonly cachedTokens?: number;
  readonly reasoningTokens?: number;
}

/** Normalizes raw usage to ProviderUsage. @param raw - raw counts @returns normalized usage */
export function mapProviderUsage(raw: ProviderUsageRaw): ProviderUsage {
  const total = raw.promptTokens + raw.completionTokens;
  return {
    promptTokens: raw.promptTokens,
    completionTokens: raw.completionTokens,
    totalTokens: total,
    ...(raw.cachedTokens !== undefined ? { cachedTokens: raw.cachedTokens } : {}),
    ...(raw.reasoningTokens !== undefined ? { reasoningTokens: raw.reasoningTokens } : {}),
  };
}
