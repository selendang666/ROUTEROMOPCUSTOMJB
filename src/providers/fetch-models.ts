import { capabilitiesOf, modelOf } from "../proxy/types/provider.js";
import { isRecord } from "../proxy/validation.js";

import type { ProviderModel } from "../proxy/types/provider.js";

export interface FetchModelsOptions {
  readonly baseUrl: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  readonly fetcher?: typeof fetch;
}

/**
 * Tolerant OpenAI-compatible `/models` fetcher shared by inbuilt discovery.
 * Tolerant parser (`data|models|items|array`, `positiveNumber`/`pricingOf`,
 * `modelOf` with `context`/`pricing`, sorted). Bounded with
 * `AbortSignal.timeout(10_000)` + `AbortSignal.any` so an external signal
 * can cancel without losing the deadline. No endpoint map, no cache, no
 * `ProviderId` knowledge — each adapter owns its `baseUrl` and headers.
 *
 * @param options - baseUrl + headers + optional abort signal
 * @returns discovered models or `null` when the endpoint is not compatible
 */
export async function fetchOpenAICompatibleModels(
  options: FetchModelsOptions,
): Promise<readonly ProviderModel[] | null> {
  const fetcher = options.fetcher ?? fetch;
  const url = `${options.baseUrl.replace(/\/+$/, "")}/models`;
  const timeoutSignal = AbortSignal.timeout(10_000);
  const signal = options.signal === undefined ? timeoutSignal : AbortSignal.any([options.signal, timeoutSignal]);
  try {
    const response = await fetcher(url, {
      headers: {
        ...(options.headers ?? {}),
        accept: "application/json",
      },
      signal,
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as unknown;
    const entries = extractEntries(payload);
    if (entries === null) return null;
    const byId = new Map<string, ProviderModel>();
    for (const entry of entries) {
      const id = typeof entry.id === "string" && entry.id.length > 0 ? entry.id : null;
      if (id === null) continue;
      const contextWindow =
        positiveNumber(entry.context_length) ??
        positiveNumber(entry.contextWindow) ??
        positiveNumber(entry.max_input_tokens) ??
        131_072;
      const maxOutputTokens =
        positiveNumber(entry.max_output_tokens) ??
        positiveNumber(entry.maxTokens) ??
        16_384;
      const outputTokens = Math.min(maxOutputTokens, contextWindow);
      byId.set(
        id,
        modelOf(
          id,
          typeof entry.name === "string" && entry.name.length > 0 ? entry.name : id,
          capabilitiesOf({ surfaces: ["openai-chat"] }),
          {
            context: { inputTokens: contextWindow, outputTokens },
            pricing: pricingOf(entry.pricing),
          },
        ),
      );
    }
    return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
  } catch {
    return null;
  }
}

function positiveNumber(value: unknown): number | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim().length > 0
        ? Number(value)
        : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function pricingOf(value: unknown): { inputPerMillion: number | null; outputPerMillion: number | null } | undefined {
  if (!isRecord(value)) return undefined;
  const input = positiveNumber(value.input) ?? positiveNumber(value.prompt);
  const output = positiveNumber(value.output) ?? positiveNumber(value.completion);
  if (input === null && output === null) return undefined;
  const perMillion = (amount: number | null): number | null =>
    amount === null ? null : amount < 1 ? amount * 1_000_000 : amount;
  return { inputPerMillion: perMillion(input), outputPerMillion: perMillion(output) };
}

function extractEntries(payload: unknown): readonly Record<string, unknown>[] | null {
  if (Array.isArray(payload)) return payload.filter(isRecord);
  if (!isRecord(payload)) return null;
  for (const key of ["data", "models", "items"] as const) {
    const value = payload[key];
    if (Array.isArray(value)) return value.filter(isRecord);
  }
  return null;
}
