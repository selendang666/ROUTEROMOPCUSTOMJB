import type { TranslationDiagnostic } from "../types/telemetry.js";
/**
 * Client detection — format detection, client profile resolution, endpoint routing.
 * Extracted from translate.ts for single-responsibility.
 */

import { isRecord } from "../validation.js";
import type { HeaderSnapshot } from "../protocol-request.js";
import type { ClientDetectionSource, ClientIdentity, ClientName } from "../types/request.js";
import type { ProxyEndpoint as DetectionEndpoint } from "../types/routing.js";
import type { Surface } from "../types/surface.js";

// Re-export ClientIdentity for live callers that previously imported from application/contracts via codec.
export type { ClientIdentity, ClientName, ClientDetectionSource } from "../types/request.js";

// ── Whitespace utilities (shared with translate.ts) ──────────────────────────

export function isWhitespaceCode(code: number): boolean {
  return code === 32 || (code >= 9 && code <= 13) || code === 160 || code === 65279 || code === 5760 || code === 6158 || (code >= 8192 && code <= 8202) || code === 8232 || code === 8233 || code === 8239 || code === 8287 || code === 12288;
}

export function scanTrim(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && isWhitespaceCode(text.charCodeAt(start))) start++;
  while (end > start && isWhitespaceCode(text.charCodeAt(end - 1))) end--;
  return start === 0 && end === text.length ? text : text.slice(start, end);
}

export function scanTrimEnd(text: string): string {
  let end = text.length;
  while (end > 0 && isWhitespaceCode(text.charCodeAt(end - 1))) end--;
  return end === text.length ? text : text.slice(0, end);
}

// ── Detection types ──────────────────────────────────────────────────────────

export type ClientFormat =
  | "openai-chat"
  | "openai-responses"
  | "anthropic-messages"
  | "cursor-chat-hybrid"
  | "gemini"
  | "gemini-cli"
  | "codex"
  | "unknown";

export type ClientProfileName =
  | "claude-code"
  | "codex"
  | "cursor"
  | "gemini-cli"
  | "cline"
  | "opencode"
  | "github-copilot"
  | "unknown";

export type DetectionSource = "header" | "user-agent" | "endpoint" | "body-shape" | "prompt" | "unknown";

export type DetectionConfidence = "explicit" | "strong" | "fallback";

export interface ClientProfile {
  readonly name: ClientProfileName;
  readonly format: ClientFormat;
  /** Source of the CLI identity signal used for tracking. */
  readonly source: DetectionSource;
  /** Source of the wire-shape signal used for parsing and encoding. */
  readonly formatSource: DetectionSource;
  readonly passthrough: "never" | "same-protocol-only" | "native";
  readonly rawUserAgent?: string;
}

export interface FormatDetectionResult {
  readonly profile: ClientProfile;
  readonly endpointSurface: Surface;
  readonly confidence: DetectionConfidence;
  readonly conflicts: readonly string[];
}

interface DetectionCandidate {
  readonly profile: ClientProfile;
  readonly confidence: DetectionConfidence;
}

// ── Detection constants ──────────────────────────────────────────────────────

const CLIENT_ALIASES: Readonly<Record<string, ClientProfileName>> = Object.freeze({
  claude: "claude-code",
  claude_code: "claude-code",
  "claude-code": "claude-code",
  cline: "cline",
  codex: "codex",
  cursor: "cursor",
  gemini: "gemini-cli",
  "gemini-cli": "gemini-cli",
  github_copilot: "github-copilot",
  "github-copilot": "github-copilot",
  opencode: "opencode",
  pi: "unknown",
});

const USER_AGENT_CLIENTS: readonly [string, ClientProfileName][] = [
  ["claude-cli", "claude-code"],
  ["claude-code", "claude-code"],
  ["codex", "codex"],
  ["cursor", "cursor"],
  ["cline", "cline"],
  ["opencode", "opencode"],
  ["gemini-cli", "gemini-cli"],
  ["copilot", "github-copilot"],
];

const CLIENT_FORMAT_BY_NAME: Readonly<Record<ClientProfileName, ClientFormat>> = {
  "claude-code": "anthropic-messages",
  codex: "openai-responses",
  cursor: "cursor-chat-hybrid",
  "gemini-cli": "gemini-cli",
  cline: "openai-chat",
  opencode: "openai-chat",
  "github-copilot": "openai-chat",
  unknown: "openai-chat",
};

// ── Header snapshot helpers ──────────────────────────────────────────────────

export function headerSnapshotFromHeaders(headers: Headers): HeaderSnapshot {
  return {
    apiKeyHeader: headers.get("x-api-key"),
    authorization: headers.get("authorization"),
    clientName: headers.get("x-client-name"),
    userAgent: headers.get("user-agent"),
    helperMethod: headers.get("x-stainless-helper-method"),
    requestId: headers.get("x-request-id"),
    accept: headers.get("accept"),
    contentType: headers.get("content-type"),
    fingerprint: headers.get("x-fingerprint") ?? headers.get("sec-ch-ua"),
    forwardedProto: headers.get("x-forwarded-proto"),
  };
}

function isHeaders(value: Headers | HeaderSnapshot): value is Headers {
  return typeof (value as Headers).get === "function";
}

// ── Detection entry points ───────────────────────────────────────────────────

export function detectClientFormat(
  endpoint: DetectionEndpoint,
  surface: Surface,
  headers: Headers | HeaderSnapshot,
  body: unknown,
): FormatDetectionResult {
  const endpointCandidate = endpointCandidateFor(endpoint, surface);
  const bodyValue = parseBodyShape(body);
  const bodyCandidate = bodyCandidateFor(endpoint, bodyValue);
  const snapshot: HeaderSnapshot = isHeaders(headers) ? headerSnapshotFromHeaders(headers) : headers;
  const explicitCandidate = explicitHeaderCandidateFromSnapshot(snapshot);
  const userAgentCandidate = userAgentCandidateFromSnapshot(snapshot);
  const promptCandidate = promptCandidateFor(bodyValue);
  const identity = explicitCandidate ?? userAgentCandidate ?? bodyCandidate ?? promptCandidate ?? endpointCandidate;
  const wireShape = bodyCandidate ?? endpointCandidate;
  const profile = {
    ...identity.profile,
    format: wireShape.profile.format,
    formatSource: wireShape.profile.formatSource,
  } satisfies ClientProfile;
  return {
    profile,
    endpointSurface: surface,
    confidence: identity.confidence,
    conflicts: collectConflicts(endpointCandidate, bodyCandidate, explicitCandidate, userAgentCandidate),
  };
}

export function normalizationEndpoint(endpoint: DetectionEndpoint, detection: FormatDetectionResult): DetectionEndpoint {
  if (endpoint === "/v1/chat/completions" && detection.profile.formatSource === "body-shape" && detection.profile.format === "cursor-chat-hybrid") {
    return "/v1/responses";
  }
  return endpoint;
}

export function clientIdentityForProfile(profile: ClientProfile): ClientIdentity {
  const names: Readonly<Record<ClientProfileName, ClientName>> = {
    "claude-code": "claude_code",
    codex: "codex",
    cursor: "cursor",
    "gemini-cli": "gemini_cli",
    cline: "cline",
    opencode: "opencode",
    "github-copilot": "github_copilot",
    unknown: "unknown",
  };
  const sources: Readonly<Record<DetectionSource, ClientDetectionSource>> = {
    header: "explicit_header",
    "user-agent": "user_agent",
    endpoint: "endpoint",
    "body-shape": "body_shape",
    prompt: "prompt_marker",
    unknown: "unknown",
  };
  return { name: names[profile.name], source: sources[profile.source], ...(profile.rawUserAgent ? { rawUserAgent: profile.rawUserAgent } : {}) };
}

// ── Candidate evaluation ─────────────────────────────────────────────────────

function endpointCandidateFor(endpoint: DetectionEndpoint, surface: Surface): DetectionCandidate {
  if (endpoint === "/v1/messages") return candidate("unknown", "anthropic-messages", "endpoint", "fallback");
  if (endpoint === "/v1/responses" || endpoint === "/v1/responses/compact") return candidate("unknown", "openai-responses", "endpoint", "fallback");
  if (surface === "openai-chat") return candidate("unknown", "openai-chat", "endpoint", "fallback");
  return candidate("unknown", "unknown", "endpoint", "fallback");
}

function explicitHeaderCandidateFromSnapshot(snapshot: HeaderSnapshot): DetectionCandidate | null {
  const explicit = normalizeAlias(snapshot.clientName);
  if (explicit !== null) return candidateForClient(explicit, "header", "explicit");
  const helper = snapshot.helperMethod !== null ? scanTrim(snapshot.helperMethod).toLowerCase() : "";
  if (helper.includes("claude")) return candidateForClient("claude-code", "header", "explicit");
  if (helper.includes("codex")) return candidateForClient("codex", "header", "explicit");
  return null;
}

function userAgentCandidateFromSnapshot(snapshot: HeaderSnapshot): DetectionCandidate | null {
  const userAgent = snapshot.userAgent?.toLowerCase() ?? "";
  for (const [needle, name] of USER_AGENT_CLIENTS) {
    if (userAgent.includes(needle)) return candidateForClient(name, "user-agent", "strong");
  }
  const raw = snapshot.userAgent?.trim();
  return raw ? candidate("unknown", "unknown", "user-agent", "fallback", raw) : null;
}

function bodyCandidateFor(endpoint: DetectionEndpoint, body: Record<string, unknown> | null): DetectionCandidate | null {
  if (body === null) return null;
  const hasInput = Array.isArray(body.input) || typeof body.input === "string";
  if (endpoint === "/v1/chat/completions" && hasInput && !Array.isArray(body.messages)) {
    return candidate("unknown", "cursor-chat-hybrid", "body-shape", "strong");
  }
  if (endpoint === "/v1/responses" || (hasInput && !Array.isArray(body.messages))) {
    return candidate("unknown", "openai-responses", "body-shape", "strong");
  }
  return null;
}

function promptCandidateFor(body: Record<string, unknown> | null): DetectionCandidate | null {
  if (body === null || !Array.isArray(body.messages)) return null;
  const firstMarker = body.messages.find((message) => {
    if (!isRecord(message)) return false;
    return message.role === "system" || message.role === "developer";
  });
  if (!isRecord(firstMarker)) return null;
  const text = markerText(firstMarker.content);
  if (/\bclaude\s+code\b/i.test(text)) return candidate("claude-code", "anthropic-messages", "prompt", "strong");
  if (/\bcodex\b/i.test(text)) return candidate("codex", "openai-responses", "prompt", "strong");
  return null;
}

function candidateForClient(name: ClientProfileName, source: DetectionSource, confidence: DetectionConfidence): DetectionCandidate {
  return candidate(name, CLIENT_FORMAT_BY_NAME[name], source, confidence);
}

function candidate(name: ClientProfileName, format: ClientFormat, source: DetectionSource, confidence: DetectionConfidence, rawUserAgent?: string): DetectionCandidate {
  const passthrough = name === "unknown" ? "never" : "same-protocol-only";
  return { profile: { name, format, source, formatSource: source, passthrough, ...(rawUserAgent ? { rawUserAgent } : {}) }, confidence };
}

function collectConflicts(endpoint: DetectionCandidate, body: DetectionCandidate | null, explicit: DetectionCandidate | null, userAgent: DetectionCandidate | null): string[] {
  const conflicts: string[] = [];
  if (body !== null && explicit !== null && !compatibleFormats(explicit.profile.format, body.profile.format)) {
    conflicts.push("client-identity-conflicts-with-body-shape");
  }
  if (body === null && explicit !== null && !compatibleFormats(explicit.profile.format, endpoint.profile.format)) {
    conflicts.push("client-identity-conflicts-with-endpoint");
  }
  if (userAgent !== null && body !== null && !compatibleFormats(userAgent.profile.format, body.profile.format)) {
    conflicts.push("user-agent-conflicts-with-body-shape");
  }
  return conflicts;
}

function compatibleFormats(identity: ClientFormat, wire: ClientFormat): boolean {
  if (identity === wire) return true;
  return (identity === "openai-responses" && wire === "cursor-chat-hybrid") || (identity === "cursor-chat-hybrid" && wire === "openai-responses");
}

function normalizeAlias(value: string | null): ClientProfileName | null {
  if (value === null) return null;
  return CLIENT_ALIASES[scanTrim(value).toLowerCase()] ?? null;
}

function parseBodyShape(body: unknown): Record<string, unknown> | null {
  if (isRecord(body)) return body;
  return null;
}

function markerText(content: unknown): string {
  if (typeof content === "string") return content.slice(0, 512);
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is Record<string, unknown> => isRecord(block) && block.type === "text" && typeof block.text === "string")
    .map((block) => String(block.text))
    .join(" ")
    .slice(0, 512);
}

// ── Reasoning suffix (merged from reasoning.ts) ─────────────────
export type CanonicalEffort = "xhigh" | "high" | "medium" | "low" | "minimal" | "none";

const KNOWN_SUFFIX = /\((xhigh|high|medium|low|minimal|none)\)$/i;

export function parseModelReasoningSuffix(model: string): { cleanModel: string; effort: CanonicalEffort | null; diagnostic?: TranslationDiagnostic } {
  const match = KNOWN_SUFFIX.exec(model.trim());
  if (!match) return { cleanModel: model, effort: null };
  const effort = match[1]!.toLowerCase() as CanonicalEffort;
  const cleanModel = model.slice(0, match.index).trim();
  return {
    cleanModel,
    effort,
    diagnostic: {
      stage: "normalization",
      sourceFormat: model,
      targetSurface: "model",
      fieldCategory: "reasoning",
      action: "adapted",
      reason: `stripped reasoning suffix (${effort})`,
    },
  };
}
