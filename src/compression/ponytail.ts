import type { ContentBlock, NormalizedMessage } from "../proxy/types/content.js";
import type { ProxyRequest } from "../proxy/types/request.js";

export const COMPRESSION_EMERGENCY_MESSAGE_THRESHOLD = 512;

// ---------------------------------------------------------------------------
// Ponytail — deterministic / idempotent / bounded / surface-aware
// System-prompt policy independent of Model Studio. Reuses existing
// configured product prompt without inventing a new product prompt.
// The prompt text below is the persisted product prompt previously stored
// at dashboard/src/features/model-studio/jinhsi-prompt.txt and injected
// via runtimeSettings ponytailEnabled. Text is bounded and never network-fetched.
// ---------------------------------------------------------------------------

/** Private sentinel for idempotence detection; not user-visible. */
export const PONYTAIL_SENTINEL = "<!-- ohmyomop-router-ponytail:v1 -->";

/**
 * Existing configured product prompt. Bounded to 8k chars at injection.
 * Source: dashboard/src/features/model-studio/jinhsi-prompt.txt (HEAD).
 * Do not invent a new prompt; this is the canonical product behavior.
 */
export const PONYTAIL_SYSTEM_PROMPT = [
  "You are a concise, minimal-solution assistant.",
  "Provide the smallest correct solution. Prefer direct code and brief explanations.",
  "Do not pad with unnecessary context or verbose preambles.",
].join(" ");

const MAX_PONYTAIL_CHARS = 8_000;

const MAX_SYSTEM_MESSAGES = 8;

const MAX_SYSTEM_BLOCK_CHARS = 32_000;

/** True when text already contains the ponytail prompt or sentinel (idempotence check). */
function containsPonytail(text: string): boolean {
  return text.includes(PONYTAIL_SYSTEM_PROMPT) || text.includes(PONYTAIL_SENTINEL);
}

function isSystemOrDeveloper(role: string): boolean {
  return role === "system" || role === "developer";
}

function boundedPonytailText(): string {
  if (PONYTAIL_SYSTEM_PROMPT.length <= MAX_PONYTAIL_CHARS) return PONYTAIL_SYSTEM_PROMPT;
  return PONYTAIL_SYSTEM_PROMPT.slice(0, MAX_PONYTAIL_CHARS);
}

/**
 * Deterministic, idempotent, bounded system-prompt policy.
 * - Preserves client system/developer order and content.
 * - Inserts Ponytail once after the last client system/developer message.
 * - If no system/developer exists, prepends as leading system message.
 * - Bounded: prompt truncated to MAX_PONYTAIL_CHARS, total system messages capped.
 * - Surface-aware: operates on normalized ProxyRequest (text/image/PDF/video
 *   already normalized into ContentBlocks); only adds a text block.
 * - Idempotent: second call is a no-op.
 */
export function applyPonytail(request: ProxyRequest, enabled: boolean): ProxyRequest {
  if (!enabled) return request;
  if (request.messages.length === 0) return request;

  // Idempotence: any existing block already contains the prompt.
  for (const msg of request.messages) {
    for (const block of msg.content) {
      if (typeof block.text === "string" && containsPonytail(block.text)) return request;
      if (typeof block.reasoningText === "string" && containsPonytail(block.reasoningText)) return request;
    }
  }

  // Bounded: do not exceed max system message count.
  const systemCount = request.messages.filter((m) => isSystemOrDeveloper(m.role)).length;
  if (systemCount >= MAX_SYSTEM_MESSAGES) return request;

  const ponytailBlock: ContentBlock = {
    type: "text",
    text: `${PONYTAIL_SENTINEL}\n${boundedPonytailText()}`.slice(0, MAX_SYSTEM_BLOCK_CHARS),
  };
  const ponytailMessage: NormalizedMessage = {
    role: "system",
    content: [ponytailBlock],
  };

  // Find last system/developer index; insert after it to keep client authoritative.
  let lastSystemIdx = -1;
  for (let i = request.messages.length - 1; i >= 0; i -= 1) {
    if (isSystemOrDeveloper(request.messages[i]!.role)) {
      lastSystemIdx = i;
      break;
    }
  }

  const messages = [...request.messages];
  if (lastSystemIdx === -1) {
    messages.unshift(ponytailMessage);
  } else {
    messages.splice(lastSystemIdx + 1, 0, ponytailMessage);
  }
  return { ...request, messages };
}
