import type { ContentBlock, NormalizedMessage } from "../proxy/types/content.js";
import type { ProxyRequest } from "../proxy/types/request.js";
import type { GlobalPersonaSnapshot } from "./snapshot.js";

/** Private marker for the injected persona; not user-visible. */
export const PERSONA_SENTINEL = "<!-- ohmyomop-router-persona:v1 -->";

/** Persona text is truncated to this many chars at injection time. */
export const MAX_PERSONA_CHARS = 32_000;

/** Max chars of the final injected system block. */
export const MAX_PERSONA_BLOCK_CHARS = 40_000;

function boundedPersonaText(content: string): string {
  const trimmed = content.trim();
  if (trimmed.length <= MAX_PERSONA_CHARS) return trimmed;
  return trimmed.slice(0, MAX_PERSONA_CHARS);
}

/**
 * Prepends the locked global persona as the leading system message.
 * - No-op when the snapshot is disabled or empty.
 * - Removes every client system message and prepends exactly one bounded system message.
 * @param request Normalized proxy request.
 * @param persona Live persona snapshot.
 * @returns Request with the persona prepended, or the request unchanged.
 */
export function applyGlobalPersona(request: ProxyRequest, persona: GlobalPersonaSnapshot): ProxyRequest {
  if (!persona.enabled) return request;
  if (persona.content.trim().length === 0) return request;

  const label = [persona.name, persona.version].filter((part) => part.length > 0).join(" ");
  const header = label.length > 0 ? `# Global persona: ${label}` : "# Global persona";
  const personaBlock: ContentBlock = {
    type: "text",
    text: `${PERSONA_SENTINEL}\n${header}\n${boundedPersonaText(persona.content)}`.slice(0, MAX_PERSONA_BLOCK_CHARS),
  };
  const personaMessage: NormalizedMessage = {
    role: "system",
    content: [personaBlock],
  };
  return { ...request, messages: [personaMessage, ...request.messages.filter((message) => message.role !== "system")] };
}

export function applyGlobalPersonaToOpenAIPayload(body: Readonly<Record<string, unknown>>, persona: GlobalPersonaSnapshot | null): Readonly<Record<string, unknown>> {
  if (persona === null || !persona.enabled || persona.content.trim().length === 0 || !Array.isArray(body.messages)) return body;
  const label = [persona.name, persona.version].filter((part) => part.length > 0).join(" ");
  const header = label.length > 0 ? `# Global persona: ${label}` : "# Global persona";
  const content = `${PERSONA_SENTINEL}\n${header}\n${boundedPersonaText(persona.content)}`.slice(0, MAX_PERSONA_BLOCK_CHARS);
  const messages = body.messages.filter((message) => typeof message !== "object" || message === null || Array.isArray(message) || (message as { readonly role?: unknown }).role !== "system");
  return { ...body, messages: [{ role: "system", content }, ...messages] };
}
