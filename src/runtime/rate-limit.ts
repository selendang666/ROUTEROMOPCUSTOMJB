// Rate-limit error classification and backoff calculation
// Extracted from admission.ts verbatim
import { parseRateLimitReason } from "../proxy/types/error-types.js";

/**
 * Rate-limit error classification and backoff calculation.
 *
 * Classifies upstream error messages into actionable categories that drive credential rotation vs.
 * in-place backoff decisions. The core distinction is:
 *
 *   - QUOTA_EXHAUSTED     → persistent, rotate to a sibling credential (30 min)
 *   - RATE_LIMIT_EXCEEDED → transient per-minute cap, stay + backoff 30s
 *   - MODEL_CAPACITY      → server overloaded, stay + backoff 45-75s w/ jitter
 *   - SERVER_ERROR        → 5xx, stay + backoff 20s
 *   - UNKNOWN             → conservative 5 min default
 *
 * This prevents burning sibling credentials on transient 429s while ensuring
 * real account-level quota exhaustion rotates immediately.
 */



const ACCOUNT_RATE_LIMIT_PATTERN =
  /\baccount(?:'s)?\b[^\n]{0,80}\brate.?limit\b|\brate.?limit\b[^\n]{0,80}\baccount\b/i;

const SPEND_LIMIT_PATTERN = /spend.?limit/i;

const OPENROUTER_DAILY_FREE_LIMIT_PATTERN = /\bfree[-_ ]models[-_ ]per[-_ ]day\b/i;

const USAGE_LIMIT_PATTERN =
  /usage.?limit|usage_limit_reached|usage_not_included|limit_reached|quota.?(?:exceeded|reached|insufficient)|resource.?exhausted|exhausted your capacity|quota will reset|insufficient.?(?:balance|quota)|balance.?exhausted|run out of credits|out of credits|spending[- _]?limit|personal-team-blocked/i;

/**
 * HTTP status codes that represent an account-local usage cap rather than a
 * bad credential or a transient blip. 402 = payment/billing cap (xAI Grok
 * Build, DeepSeek, OpenRouter credit exhaustion).
 */
export function isUsageLimitStatus(status: number | undefined | null): boolean {
  return status === 429 || status === 402;
}

/**
 * Returns true for failures that should burn one credential and rotate to a
 * sibling account. Decision tree:
 *
 *  1. Body matches usage-limit text → rotate.
 *  2. Status is not a usage-limit status (429/402) → backoff.
 *  3. Body is absent or opaque → rotate conservatively.
 *  4. Body has content → only QUOTA_EXHAUSTED rotates.
 */
export function isUsageLimitOutcome(status: number | undefined | null, message: string | undefined | null): boolean {
  if (message && matchesUsageLimitText(message)) return true;
  if (!isUsageLimitStatus(status)) return false;
  // Opaque/empty 429 bodies carry no real quota signal — do NOT classify as
  // quota_exceeded (which triggers a full 5-min cooldown + per-model lock on
  // a single transient blip). Let them fall through to provider_rate_limited,
  // which gets a short graduated backoff that grows with failure count.
  if (!message || isOpaqueStatusBody(message)) return false;
  return parseRateLimitReason(message) === "QUOTA_EXHAUSTED";
}

/**
 * A usage-limit status body is opaque when it carries no signal beyond the
 * status itself — empty, whitespace-only, or just the status digits with
 * HTTP/JSON framing.
 */
export function isOpaqueStatusBody(message: string): boolean {
  const cleaned = message
    .replace(/\b(?:429|402)\b/g, "")
    .replace(/\b(?:http|https|status|error|code|response|message)\b/gi, "");
  return !/[a-z\d]{3,}/i.test(cleaned);
}

/**
 * Internal text matcher for usage/quota-limit phrasing. Returns true when the
 * message contains persistent-cap signals (Codex `usage_limit_reached`,
 * Anthropic account rate-limit, Google `resource_exhausted`, OpenAI
 * `insufficient_quota`, xAI "run out of credits", etc.).
 */
export function matchesUsageLimitText(errorMessage: string): boolean {
  return (
    USAGE_LIMIT_PATTERN.test(errorMessage) ||
    SPEND_LIMIT_PATTERN.test(errorMessage) ||
    ACCOUNT_RATE_LIMIT_PATTERN.test(errorMessage) ||
    OPENROUTER_DAILY_FREE_LIMIT_PATTERN.test(errorMessage)
  );
}

