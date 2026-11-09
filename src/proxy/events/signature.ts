import type { ProxyRequest } from "../types/request.js";
import type { ProviderQuirkPolicy } from "../types/provider.js";
import type { TranslationDiagnostic } from "../types/telemetry.js";
import { createInternalFailure } from "../errors.js";

export interface SignatureValidationResult {
  readonly request: ProxyRequest;
  readonly diagnostics: readonly TranslationDiagnostic[];
  readonly changed: boolean;
}

function isValidSignature(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 4096 && !/[^\x20-\x7E]/.test(trimmed);
}

/**
 * Validates reasoning signatures per assistant occurrence.
 * - preserve: bounded signatures kept as-is
 * - strip-invalid: removes only invalid signatures with diagnostic
 * - require: throws capability_unsupported unless provider declares exact placeholder
 */
export function validateReasoningSignatures(
  request: ProxyRequest,
  policy: ProviderQuirkPolicy["signatures"],
): SignatureValidationResult {
  if (policy === undefined || policy.mode === "preserve") {
    return { request, diagnostics: [], changed: false };
  }

  const diagnostics: TranslationDiagnostic[] = [];
  let changed = false;

  if (policy.mode === "require") {
    const hasPlaceholder = typeof policy.placeholder === "string" && policy.placeholder.length > 0;
    if (!hasPlaceholder) {
      // check if any assistant tool_use lacks valid signature
      for (const msg of request.messages) {
        if (msg.role !== "assistant") continue;
        for (const block of msg.content) {
          if (block.type === "tool_use" || block.type === "reasoning") {
            const sig = (block as unknown as { reasoningSignature?: string }).reasoningSignature;
            if (sig === undefined || !isValidSignature(sig)) {
              throw createInternalFailure({
                kind: "capability_unsupported",
                safeMessage: "reasoning signature required but not provided",
                statusCode: 400,
                retryable: false,
                routeScope: null,
              });
            }
          }
        }
      }
      return { request, diagnostics, changed: false };
    }
    // if placeholder exists, we could inject but spec says throw unless placeholder declared, so with placeholder we preserve/inject later projection
    return { request, diagnostics, changed: false };
  }

  if (policy.mode === "strip-invalid") {
    const newMessages = request.messages.map((msg) => {
      if (msg.role !== "assistant") return msg;
      let msgChanged = false;
      const newContent = msg.content.map((block) => {
        if (block.type !== "tool_use" && block.type !== "reasoning") return block;
        const sig = (block as unknown as { reasoningSignature?: string }).reasoningSignature;
        if (sig !== undefined && !isValidSignature(sig)) {
          msgChanged = true;
          changed = true;
          diagnostics.push({
            stage: "policy",
            sourceFormat: request.sourceSurface,
            targetSurface: "tool_call",
            fieldCategory: "signatures",
            action: "adapted",
            reason: "stripped invalid reasoning signature",
          });
          const { reasoningSignature: _removed, ...rest } = block as unknown as { reasoningSignature?: unknown } & Record<string, unknown>;
          return rest as unknown as typeof block;
        }
        return block;
      });
      if (msgChanged) return { ...msg, content: newContent };
      return msg;
    });
    if (changed) {
      return { request: { ...request, messages: newMessages }, diagnostics, changed: true };
    }
    return { request, diagnostics, changed: false };
  }

  return { request, diagnostics, changed: false };
}
