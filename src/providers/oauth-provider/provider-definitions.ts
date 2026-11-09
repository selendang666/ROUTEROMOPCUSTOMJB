import type { ProviderDefinition } from "../model-catalog.js";

export const OAUTH_PROVIDER_DEFINITIONS = [
  { id: "antigravity", displayName: "Google Antigravity", access: "oauth", protocol: "gemini" },
  { id: "codex", displayName: "OpenAI Codex", access: "oauth", protocol: "openai" },
  { id: "claude", displayName: "Claude Code", access: "oauth", protocol: "anthropic" },
  { id: "zaicp", displayName: "Z.AI Coding Plan", access: "oauth", protocol: "openai", credentialKinds: ["oauth", "api_key"] },
  { id: "kimi-code", displayName: "Kimi Code", access: "oauth", protocol: "openai" },
  { id: "github", displayName: "GitHub Copilot", access: "oauth", protocol: "openai" },
  { id: "cursor", displayName: "Cursor", access: "oauth", protocol: "openai" },
  { id: "devin", displayName: "Devin", access: "oauth", protocol: "openai" },
  { id: "cline", displayName: "Cline", access: "oauth", protocol: "openai", credentialKinds: ["oauth", "api_key"] },
  { id: "cline-pass", displayName: "Cline Pass", access: "oauth", protocol: "openai", credentialKinds: ["oauth", "api_key"] },
] as const satisfies readonly ProviderDefinition[];

export const OAUTH_PROVIDER_IDS = OAUTH_PROVIDER_DEFINITIONS.map((definition) => definition.id);

export type OAuthProviderId = (typeof OAUTH_PROVIDER_IDS)[number];
