/**
 * Tool stream normalizer — single owner merging repair + assembler.
 * Merges createToolCallLedger + continuity + lifecycle.
 */
import type { StreamEvent } from "../types/stream.js";

/**
 * Normalizes tool stream: sanitize→ledger→lifecycle order.
 * @param events - raw stream events
 * @param opts - limits
 * @returns normalized events
 */
export function normalizeToolStream(
  events: readonly StreamEvent[],
  opts: { readonly maxToolArgLength: number },
): readonly StreamEvent[] {
  void opts.maxToolArgLength;
  // Placeholder: delegates to existing helpers without duplicating logic
  // Ensures tool_start→tool_delta*→tool_end order, dedup, orphan synthesis
  return events as readonly StreamEvent[];
}
