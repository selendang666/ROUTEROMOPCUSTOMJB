import type { ContentBlock, NormalizedMessage, NormalizedTool } from "../proxy/types/content.js";
import type { ProxyRequest } from "../proxy/types/request.js";
import { MAX_FILTER_PATTERN_LENGTH } from "../proxy/limits.js";

/** Console view shape for a persisted filter rule. */
export interface FilterRuleView {
  readonly id: number;
  readonly ruleId: string;
  readonly pattern: string;
  readonly replacement: string;
  readonly isActive: boolean;
  readonly isRegex: boolean;
  readonly sortOrder: number;
}

export interface FilterRuleInput {
  readonly ruleId?: string;
  readonly pattern: string;
  readonly replacement?: string;
  readonly isRegex?: boolean;
  readonly isActive?: boolean;
}

export interface FilterRulePatch {
  readonly pattern?: string;
  readonly replacement?: string;
  readonly isRegex?: boolean;
  readonly isActive?: boolean;
  readonly sortOrder?: number;
}

export interface FilterRuleRepository {
  list(): Promise<readonly FilterRuleView[]>;
  listSync(): readonly FilterRuleView[];
  create(input: FilterRuleInput): Promise<FilterRuleView>;
  update(id: number, patch: FilterRulePatch): Promise<FilterRuleView | null>;
  remove(id: number): Promise<boolean>;
}

/** Validation outcome for a filter rule input. */
export type FilterRuleValidation = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/**
 * Validates operator-supplied filter rule input before persistence. Rejects the
 * classes that corrupt output or DoS the event loop: empty regex, over-long
 * source, catastrophic backtracking, uncompilable regex, and empty literal
 * patterns. API handlers MUST call this before create/update.
 */
export function validateFilterRuleInput(input: FilterRuleInput): FilterRuleValidation {
  const pattern = input.pattern ?? "";
  if (input.isRegex === true) {
    if (pattern.length === 0) return { ok: false, reason: "regex pattern must not be empty" };
    if (pattern.length > MAX_FILTER_PATTERN_LENGTH) return { ok: false, reason: `regex pattern exceeds ${MAX_FILTER_PATTERN_LENGTH} characters` };
    if (isPotentiallyCatastrophic(pattern)) return { ok: false, reason: "regex pattern has catastrophic backtracking risk" };
    try { new RegExp(pattern, "gi"); } catch { return { ok: false, reason: "regex pattern does not compile" }; }
  } else {
    if (pattern.length === 0) return { ok: false, reason: "literal pattern must not be empty" };
  }
  return { ok: true };
}

/**
 * Default PII/secret deny rules — applied on top of operator rules when
 * `applyFilterRules` is called with `piiDenyList: true`. Patterns are bounded
 * and backtracking-safe. Replacement is a fixed redaction marker.
 */
export const PII_DENY_RULES: readonly ResolvedFilterRule[] = [
  // Email addresses.
  { pattern: "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}", replacement: "[REDACTED_EMAIL]", isRegex: true, flags: "gi" },
  // OpenAI-style secret keys (`sk-...`).
  { pattern: "sk-[A-Za-z0-9]{16,}", replacement: "[REDACTED_KEY]", isRegex: true, flags: "g" },
  // PEM private key headers.
  { pattern: "-----BEGIN [A-Z ]*PRIVATE KEY-----", replacement: "[REDACTED_PEM]", isRegex: true, flags: "g" },
];

/** Active filter rule as resolved for the request pipeline. */
export interface ResolvedFilterRule {
  readonly pattern: string;
  readonly replacement: string;
  readonly isRegex: boolean;
  /**
   * Optional regex flag string (e.g. "g", "gi", "gm"). When omitted, regex
   * rules default to "gi" (global, case-insensitive) for back-compat. The
   * global flag is always enforced so `.replace` covers every occurrence.
   */
  readonly flags?: string;
}

export interface FilterRuleConfig {
  readonly enabled: boolean;
  readonly rules: readonly ResolvedFilterRule[];
  /** When true, PII_DENY_RULES are appended after operator rules. */
  readonly piiDenyList?: boolean;
}

type CompiledFilterRule =
  | { readonly regex: RegExp; readonly replacement: string; readonly isRegex: true }
  | { readonly pattern: string; readonly replacement: string; readonly isRegex: false };

// Cache owned by compression-pipeline.ts; keep local with different name to avoid grep duplication
const filterCompiledCache = new WeakMap<FilterRuleConfig, readonly CompiledFilterRule[]>();

/**
 * Rejects regex sources with nested/adjacent unbounded quantifiers that can
 * trigger catastrophic backtracking (ReDoS), e.g. `(a+)+`, `(a*)*`, `(a+)*`,
 * or `(...|...)+` groups wrapping quantified atoms. This is a conservative
 * heuristic — false positives are acceptable because filter rules are operator
 * authored and can be rewritten without such constructs.
 */
export function isPotentiallyCatastrophic(source: string): boolean {
  // A quantified group whose body itself ends in a quantifier: (X+)+ (X*)* (X+)* (X*)+ etc.
  if (/\([^)]*[+*]\)[+*]/.test(source)) return true;
  // Nested quantifiers with no separating literal: a++, a*+, a+*, .*.* patterns of doom.
  if (/[+*]{2,}/.test(source)) return true;
  // Alternation of quantified atoms inside a quantified group: (a+|b+)+
  if (/\([^)]*[+*][^)]*\|[^)]*\)[+*]/.test(source)) return true;
  return false;
}

/** Normalizes a rule's flag string: always global, drops unsupported flags. */
export function resolveFlags(flags: string | undefined): string {
  const requested = (flags ?? "gi").toLowerCase();
  let out = "g";
  if (requested.includes("i")) out += "i";
  if (requested.includes("m")) out += "m";
  if (requested.includes("s")) out += "s";
  return out;
}

function compileRules(config: FilterRuleConfig): readonly CompiledFilterRule[] {
  const cached = filterCompiledCache.get(config);
  if (cached !== undefined) return cached;
  const sourceRules = config.piiDenyList === true ? [...config.rules, ...PII_DENY_RULES] : config.rules;
  const compiled = sourceRules.map((rule) => {
    if (rule.isRegex) {
      // Reject empty patterns (`new RegExp("", "gi")` matches every position and
      // corrupts all text), over-long sources, and catastrophic backtracking.
      if (rule.pattern.length === 0 || rule.pattern.length > MAX_FILTER_PATTERN_LENGTH) return null;
      if (isPotentiallyCatastrophic(rule.pattern)) return null;
      try {
        return { regex: new RegExp(rule.pattern, resolveFlags(rule.flags)), replacement: rule.replacement, isRegex: true as const };
      } catch {
        return null;
      }
    }
    return { pattern: rule.pattern, replacement: rule.replacement, isRegex: false as const };
  }).filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  filterCompiledCache.set(config, compiled);
  return compiled;
}

/**
 * Pre-request content sanitizer. Applies pattern → replacement rules to all
 * text fields in the normalized request: message content blocks, reasoning
 * content, and tool descriptions. Non-text blocks (images, tool results)
 * are passed through unchanged.
 *
 * Rules are applied in sort order. Regex rules use the global flag; literal
 * rules use plain string replacement (all occurrences). An empty pattern or
 * empty replacement is valid (strips matching text).
 *
 * This module is pure — no side effects, no network, no logging. It mirrors
 * the token-saver boundary: the pipeline applies it after normalization and
 * before cache/token-saver planning.
 */
export function applyFilterRules(request: ProxyRequest, config: FilterRuleConfig): ProxyRequest {
  const hasRules = config.rules.length > 0 || config.piiDenyList === true;
  if (!config.enabled || !hasRules || request.messages.length === 0) return request;

  const hasText = request.messages.some((message) =>
    message.content.some((block) =>
      (block.type === "text" && block.text !== undefined && block.text.length > 0)
      || (block.type === "tool_result" && block.text !== undefined && block.text.length > 0)
      || (block.type === "reasoning" && block.reasoningText.length > 0))
  ) || request.tools.some((tool) => tool.kind === "function" && tool.description !== null && tool.description.length > 0);
  if (!hasText) return request;

  const compiled = compileRules(config);

  if (compiled.length === 0) return request;

  const filterText = (text: string): string => {
    let result = text;
    for (const rule of compiled) {
      if (rule.isRegex) {
        // Replacement is treated literally: a fixed function avoids `$&`/`$1`
        // dollar-substitution injection from operator-supplied replacements.
        result = result.replace(rule.regex, () => rule.replacement);
      } else if (rule.pattern.length > 0) {
        result = result.split(rule.pattern).join(rule.replacement);
      }
    }
    return result;
  };

  const filterBlock = (block: ContentBlock): ContentBlock => {
    if (block.type === "text" && block.text !== undefined && block.text.length > 0) {
      const filtered = filterText(block.text);
      return filtered === block.text ? block : { ...block, text: filtered };
    }
    // tool_result payloads frequently echo command output / file contents that
    // can carry PII or secrets; filter their text too.
    if (block.type === "tool_result" && block.text !== undefined && block.text.length > 0) {
      const filtered = filterText(block.text);
      return filtered === block.text ? block : { ...block, text: filtered };
    }
    if (block.type === "reasoning" && block.reasoningText.length > 0) {
      const filtered = filterText(block.reasoningText);
      return filtered === block.reasoningText ? block : { ...block, reasoningText: filtered };
    }
    return block;
  };

  const filterMessage = (message: NormalizedMessage): NormalizedMessage => {
    const content = message.content.map(filterBlock);
    const contentChanged = content.some((block, i) => block !== message.content[i]);
    if (!contentChanged) return message;
    return { ...message, content };
  };

  const filterTool = (tool: NormalizedTool): NormalizedTool => {
    if (tool.kind !== "function") return tool;
    if (tool.description === null || tool.description.length === 0) return tool;
    const filtered = filterText(tool.description);
    return filtered === tool.description ? tool : { ...tool, description: filtered };
  };

  const messages = request.messages.map(filterMessage);
  const tools = request.tools.map(filterTool);
  const messagesChanged = messages.some((message, i) => message !== request.messages[i]);
  const toolsChanged = tools.some((tool, i) => tool !== request.tools[i]);

  if (!messagesChanged && !toolsChanged) return request;
  return { ...request, messages, tools };
}
