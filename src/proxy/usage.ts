import type { ProviderUsage } from "./types/telemetry.js";
import { isRecord } from "./validation.js";

/** Returns a bounded non-negative integer for provider usage fields. */
export function usageNumber(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}

/**
 * Normalizes providers whose input token field includes cache reads/writes.
 * The shared contract stores uncached input separately from cache token counts.
 */
export function usageFromTotalInput(
  inputTokens: number | null,
  outputTokens: number | null,
  cacheReadTokens: number | null,
  cacheWriteTokens: number | null,
  totalTokens: number | null = null,
  reasoningTokens?: number | null,
): ProviderUsage {
  const input = inputTokens === null ? null : usageNumber(inputTokens);
  const output = outputTokens === null ? null : usageNumber(outputTokens);
  const cacheRead = cacheReadTokens === null ? null : usageNumber(cacheReadTokens);
  const cacheWrite = cacheWriteTokens === null ? null : usageNumber(cacheWriteTokens);
  const uncachedInput = input === null ? null : Math.max(0, input - usageNumber(cacheRead) - usageNumber(cacheWrite));
  const fullInput = uncachedInput === null ? null : uncachedInput + usageNumber(cacheRead) + usageNumber(cacheWrite);
  const promptTokens = fullInput ?? 0;
  const completionTokens = output ?? 0;
  const total = totalTokens === null ? promptTokens + completionTokens : usageNumber(totalTokens);
  return {
    promptTokens,
    completionTokens,
    cachedTokens: usageNumber(cacheRead),
    inputTokens: uncachedInput,
    outputTokens: output,
    totalTokens: total,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    ...(reasoningTokens === undefined ? {} : { reasoningTokens: reasoningTokens === null ? null : usageNumber(reasoningTokens) }),
    source: "provider",
  };
}

/** Normalizes Anthropic-style usage where input_tokens excludes cache tokens. */
export function usageFromUncachedInput(
  inputTokens: number | null,
  outputTokens: number | null,
  cacheReadTokens: number | null,
  cacheWriteTokens: number | null,
  totalTokens: number | null = null,
  reasoningTokens?: number | null,
): ProviderUsage {
  const input = inputTokens === null ? null : usageNumber(inputTokens);
  const output = outputTokens === null ? null : usageNumber(outputTokens);
  const cacheRead = cacheReadTokens === null ? null : usageNumber(cacheReadTokens);
  const cacheWrite = cacheWriteTokens === null ? null : usageNumber(cacheWriteTokens);
  const fullInput = input === null ? null : input + usageNumber(cacheRead) + usageNumber(cacheWrite);
  const promptTokens = fullInput ?? 0;
  const completionTokens = output ?? 0;
  const total = totalTokens === null ? promptTokens + completionTokens : usageNumber(totalTokens);
  return {
    promptTokens,
    completionTokens,
    cachedTokens: usageNumber(cacheRead),
    inputTokens: input,
    outputTokens: output,
    totalTokens: total,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    ...(reasoningTokens === undefined ? {} : { reasoningTokens: reasoningTokens === null ? null : usageNumber(reasoningTokens) }),
    source: "provider",
  };
}

/** Returns the complete prompt size represented by normalized usage. */
export function fullPromptTokens(usage: ProviderUsage): number {
  return usageNumber(usage.inputTokens) + usageNumber(usage.cacheReadTokens) + usageNumber(usage.cacheWriteTokens);
}

export { isRecord };

export function narrowNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function numberField(record: Record<string, unknown>, key: string): number | null {
  const v = record[key];
  return narrowNumber(v);
}

/** Maps OpenAI Chat usage (stream variant with prediction tokens). */
export function mapChatUsage(raw: Record<string, unknown>): ProviderUsage {
  const promptDetails = isRecord(raw.prompt_tokens_details) ? raw.prompt_tokens_details : null;
  const completionDetails = isRecord(raw.completion_tokens_details) ? raw.completion_tokens_details : null;
  return usageFromTotalInput(
    numberField(raw, "prompt_tokens"),
    numberField(raw, "completion_tokens"),
    promptDetails ? numberField(promptDetails, "cached_tokens") : null,
    promptDetails ? numberField(promptDetails, "cache_write_tokens") : null,
    numberField(raw, "total_tokens"),
    completionDetails ? numberField(completionDetails, "reasoning_tokens") : null,
  );
}

/** Maps OpenAI Responses usage (stream variant). */
export function mapResponsesUsage(raw: Record<string, unknown>): ProviderUsage {
  const inDetails = isRecord(raw.input_tokens_details) ? raw.input_tokens_details : null;
  const outDetails = isRecord(raw.output_tokens_details) ? raw.output_tokens_details : null;
  return usageFromTotalInput(
    numberField(raw, "input_tokens"),
    numberField(raw, "output_tokens"),
    inDetails ? numberField(inDetails, "cached_tokens") : null,
    inDetails ? numberField(inDetails, "cache_write_tokens") : null,
    numberField(raw, "total_tokens"),
    outDetails ? numberField(outDetails, "reasoning_tokens") : null,
  );
}

export function shouldIncludeUsage(callerWantsUsage: boolean, capabilitySupportsUsage: boolean): boolean {
  return callerWantsUsage === true && capabilitySupportsUsage === true;
}

export function streamPayloadWithUsage<T extends Record<string, unknown>>(payload: T, include: boolean): T {
  if (!include) return payload;
  const existing = (payload as Record<string, unknown>).stream_options;
  if (isRecord(existing) && existing.include_usage === true) return payload;
  return { ...payload, stream_options: { ...(isRecord(existing) ? existing : {}), include_usage: true } } as T;
}
