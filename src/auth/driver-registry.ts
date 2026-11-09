// Auth driver registry.
// The single injection point for provider auth drivers. Absence of a driver
// for a provider means there is no OAuth surface for that provider — no
// hardcoded exclusion lists.
import type { AuthDriver, AuthDriverCapabilities, AuthDriverEntry } from "./contract.js";
import { AnthropicOAuthDriver } from "./drivers/anthropic.js";
import { AntigravityOAuthDriver } from "./drivers/antigravity.js";
import { ClineOAuthDriver } from "./drivers/cline.js";
import { ClinePassOAuthDriver } from "./drivers/cline-pass.js";
import { CodexOAuthDriver } from "./drivers/codex.js";
import { ZaiOAuthDriver } from "./drivers/zai.js";
import { KimiOAuthDriver } from "./drivers/kimi.js";
import { GithubCopilotOAuthDriver } from "./drivers/github-copilot.js";
import { CursorOAuthDriver } from "./drivers/cursor.js";
import { DevinOAuthDriver } from "./drivers/devin.js";

export type { AuthDriverEntry };

const PROVIDER_ALIASES = new Map<string, string>([
  ["claude", "claude-code"],
  ["github", "github-copilot"],
]);

function resolveProviderId(providerId: string): string {
  return PROVIDER_ALIASES.get(providerId) ?? providerId;
}

/**
 * Provider-aware OAuth driver lookup. The registry is the single injection
 * point for provider auth drivers: a provider adapter never looks up a driver
 * by id itself, and a provider with no registered driver simply has no OAuth
 * flow (no hardcoded exclusion lists — absence is the only rejection).
 */
export interface AuthDriverRegistry {
  get(providerId: string): AuthDriver | null;
  has(providerId: string): boolean;
  getCapabilities(providerId: string): AuthDriverCapabilities | null;
  list(): readonly AuthDriverEntry[];
  register(providerId: string, driver: AuthDriver): void;
}

/** Bounded in-memory {@link AuthDriverRegistry}; later registrations replace earlier ones for the same id. */
export class MapAuthDriverRegistry implements AuthDriverRegistry {
  private readonly drivers = new Map<string, AuthDriver>();

  get(providerId: string): AuthDriver | null {
    return this.drivers.get(resolveProviderId(providerId)) ?? null;
  }

  has(providerId: string): boolean {
    return this.drivers.has(resolveProviderId(providerId));
  }

  getCapabilities(providerId: string): AuthDriverCapabilities | null {
    const driver = this.drivers.get(resolveProviderId(providerId));
    return driver === undefined ? null : resolveAuthDriverCapabilities(driver);
  }

  list(): readonly AuthDriverEntry[] {
    return [...this.drivers.entries()].map(([providerId, driver]) => ({ providerId, driver }));
  }

  register(providerId: string, driver: AuthDriver): void {
    if (providerId.length === 0) throw new Error("provider id must not be empty");
    this.drivers.set(providerId, driver);
  }
}

/** Derives explicit capability flags for drivers without optional metadata. */
export function resolveAuthDriverCapabilities(driver: AuthDriver): AuthDriverCapabilities {
  const declared = driver.capabilities;
  const supportsPoll = declared?.supportsPoll ?? driver.poll !== undefined;
  const supportsExchange = declared?.supportsExchange ?? driver.exchange !== undefined;
  return {
    supportsStart: declared?.supportsStart ?? driver.start !== undefined,
    supportsPoll,
    supportsExchange,
    supportsRefresh: declared?.supportsRefresh ?? driver.refresh !== undefined,
    supportsRevoke: declared?.supportsRevoke ?? driver.revoke !== undefined,
    accessOnly: declared?.accessOnly ?? (driver.kind === "oauth" && driver.refresh === undefined),
    supportsBrowser: declared?.supportsBrowser ?? (supportsExchange && !supportsPoll),
    supportsDevice: declared?.supportsDevice ?? supportsPoll,
  };
}

/**
 * Default driver registry with the bundled OAuth drivers registered. Adapter
 * agents register additional provider drivers (Kiro, Cline, Qoder, Antigravity,
 * Anthropic OAuth, ...) onto this registry from composition; providers without
 * a registered driver have no interactive OAuth surface.
 */
export function createAuthDriverRegistry(initial: readonly AuthDriverEntry[] = []): AuthDriverRegistry {
  const registry = new MapAuthDriverRegistry();
  registry.register("antigravity", new AntigravityOAuthDriver());
  registry.register("claude-code", new AnthropicOAuthDriver());
  registry.register("cline", new ClineOAuthDriver());
  registry.register("cline-pass", new ClinePassOAuthDriver());
  registry.register("codex", new CodexOAuthDriver());
  registry.register("zai-coding-plan", new ZaiOAuthDriver());
  registry.register("kimi-code", new KimiOAuthDriver());
  registry.register("github-copilot", new GithubCopilotOAuthDriver());
  registry.register("cursor", new CursorOAuthDriver());
  registry.register("devin", new DevinOAuthDriver());
  for (const entry of initial) registry.register(entry.providerId, entry.driver);
  return registry;
}
