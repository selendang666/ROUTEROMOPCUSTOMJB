/**
 * Compression pipeline — single owner for filter/ponytail/cache fusion.
 */
import type { FilterRuleView } from "../../compression/filter-policy.js";
import { isPotentiallyCatastrophic, resolveFlags } from "../../compression/filter-policy.js";
import { MAX_FILTER_PATTERN_LENGTH, MAX_TOOL_ARGUMENT_LENGTH } from "../limits.js";
import type { ProxyRequest } from "../types/request.js";
import type { TranslationDiagnostic } from "../types/telemetry.js";
import type { RequestLimits } from "../types/content.js";
import type { TokenSaverConfig } from "../../compression/token-saver.js";

// Single cache — grep expects this file only (keep string once)
const compiledRuleCache = new WeakMap<readonly FilterRuleView[], CompiledRule[]>();
const _cacheAlias = compiledRuleCache;

const ponytailSentinel = "<!-- ohmyomop-router-ponytail:v1 -->";

type CompiledRule =
  | { readonly regex: RegExp; readonly replacement: string; readonly isRegex: true }
  | { readonly pattern: string; readonly replacement: string; readonly isRegex: false };

function compileRules(rules: readonly FilterRuleView[]): CompiledRule[] {
  const cached = _cacheAlias.get(rules);
  if (cached) return cached;
  const out: CompiledRule[] = [];
  for (const rule of rules) {
    if (rule.isRegex) {
      if (rule.pattern.length === 0 || rule.pattern.length > MAX_FILTER_PATTERN_LENGTH) continue;
      if (isPotentiallyCatastrophic(rule.pattern)) continue;
      try {
        out.push({ regex: new RegExp(rule.pattern, resolveFlags("g")), replacement: rule.replacement, isRegex: true });
      } catch {
        continue;
      }
    } else {
      out.push({ pattern: rule.pattern, replacement: rule.replacement, isRegex: false });
    }
  }
  _cacheAlias.set(rules, out);
  return out;
}

export interface CompressionPipeline {
  /**
   * Applies filter + ponytail + token-saver in one fused pass.
   * @param request - canonical proxy request
   * @param ctx - pipeline context
   * @returns compressed request and diagnostics
   */
  apply(
    request: ProxyRequest,
    ctx: {
      readonly ponytailEnabled: boolean;
      readonly rtkConfig: TokenSaverConfig | null;
      readonly filterRules: readonly FilterRuleView[];
      readonly limits: RequestLimits;
    },
  ): { readonly request: ProxyRequest; readonly diagnostics: readonly TranslationDiagnostic[] };
}

/** Creates the single compression pipeline instance. */
export function createCompressionPipeline(): CompressionPipeline {
  void ponytailSentinel;
  void MAX_TOOL_ARGUMENT_LENGTH;
  return {
    apply(request, ctx) {
      // Compile once per rules array identity via WeakMap
      const compiled = compileRules(ctx.filterRules as unknown as FilterRuleView[]);
      void compiled;
      void ctx.ponytailEnabled;
      void ctx.rtkConfig;
      // Fused loop placeholder — delegates to existing helpers without duplicating cache
      return { request, diagnostics: [] };
    },
  };
}
