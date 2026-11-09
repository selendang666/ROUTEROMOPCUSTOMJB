import type { ProviderExecutionPolicy, ProviderQuirkPolicy } from "../types/provider.js";

const GEMINI_QUIRK = {
  toolNames: { maxLength: 64, replacement: "_", allowedCharacters: "alphanumeric_-" as const },
  roles: "gemini-alternating" as const,
  reasoning: { minimumOutputTokens: 16, maximumOutputTokens: 8192 },
  cache: { systemTtl: "1h" as const, toolsTtl: "1h" as const, historyTtl: "5m" as const },
  signatures: { mode: "preserve" as const },
} as const satisfies ProviderQuirkPolicy;

const CLAUDE_QUIRK = {
  requiredHeaders: { "anthropic-version": "2023-06-01" },
  cache: { systemTtl: "1h" as const, toolsTtl: "1h" as const, historyTtl: "5m" as const },
  signatures: { mode: "strip-invalid" as const },
} as const satisfies ProviderQuirkPolicy;

const CODEX_QUIRK = {
  droppedFields: ["temperature", "top_p", "max_output_tokens", "max_completion_tokens"],
  cache: { systemTtl: "1h" as const, toolsTtl: "1h" as const, historyTtl: "5m" as const },
  signatures: { mode: "preserve" as const },
} as const satisfies ProviderQuirkPolicy;

const OPENCODE_FREE_QUIRK = {
  responsesToolCloak: {
    models: ["muse-spark-1.2-contributor-free", "muse-spark-1.3-contributor-free"],
    tools: [
      { type: "function", name: "bash", description: "This tool is currently unavailable and must not be used.", parameters: { type: "object", properties: {} } },
      { type: "function", name: "read", description: "This tool is currently unavailable and must not be used.", parameters: { type: "object", properties: {} } },
    ],
    forceToolChoiceAuto: true,
  },
} as const satisfies ProviderQuirkPolicy;



const GEMINI_EXECUTION = {
  retry: { status: { 429: { attempts: 1, delayMs: 1000 }, 500: { attempts: 2, delayMs: 1000 }, 502: { attempts: 2, delayMs: 1000 }, 503: { attempts: 2, delayMs: 1000 } }, networkAttempts: 1, maxRetryAfterMs: 30000 },
} as const satisfies ProviderExecutionPolicy;

const CODEX_EXECUTION = {
  endpoints: [{ id: "primary", baseUrl: "https://chatgpt.com/backend-api" }],
  retry: { status: { 429: { attempts: 1, delayMs: 1000 }, 500: { attempts: 2, delayMs: 1000 } }, networkAttempts: 1, maxRetryAfterMs: 30000 },
  compact: { path: "/codex/responses/compact" },
  nativePassthrough: true,
} as const satisfies ProviderExecutionPolicy;

const QUIRK_POLICIES: Readonly<Record<string, ProviderQuirkPolicy>> = {
  gemini: GEMINI_QUIRK,
  claude: CLAUDE_QUIRK,
  "claude-code": CLAUDE_QUIRK,
  codex: CODEX_QUIRK,
  opencodeft: OPENCODE_FREE_QUIRK,
};

const EXECUTION_POLICIES: Readonly<Record<string, ProviderExecutionPolicy>> = {
  gemini: GEMINI_EXECUTION,
  codex: CODEX_EXECUTION,
};

export function providerExecutionPolicy(providerId: string): ProviderExecutionPolicy | undefined {
  return EXECUTION_POLICIES[providerId];
}

export function providerQuirkPolicy(providerId: string): ProviderQuirkPolicy | undefined {
  return QUIRK_POLICIES[providerId];
}
