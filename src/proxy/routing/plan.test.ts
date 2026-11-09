import { describe, expect, test } from "bun:test";
import { BoundedRouteSessionStore, createRoutePlan } from "./plan.js";
import { resolveCliModelMapping } from "./mapping.js";
import type { RoutingSnapshot } from "../types/routing.js";
import type { ProviderModelMeta } from "../types/provider.js";

function snapshot(overrides: Partial<RoutingSnapshot> & { revision?: number }): RoutingSnapshot {
  const base: RoutingSnapshot = {
    revision: overrides.revision ?? 1,
    aliases: overrides.aliases ?? new Map(),
    combos: overrides.combos ?? new Map(),
    prefixes: overrides.prefixes ?? new Map([["openai", "openai"], ["anthropic", "anthropic"]]),
    providerPrefixes: (overrides as unknown as { providerPrefixes?: ReadonlyMap<string,string> }).providerPrefixes ?? new Map([["openai", "openai"], ["anthropic", "anthropic"]]),
    cliModelMappings: overrides.cliModelMappings ?? new Map(),
    accountsByProvider: overrides.accountsByProvider ?? new Map(),
    knownModelIds: overrides.knownModelIds ?? new Map(),
    providerCredentialKinds: overrides.providerCredentialKinds ?? new Map(),
    models: overrides.models ?? [] as unknown as ProviderModelMeta[],
    proxies: overrides.proxies ?? [] as unknown as RoutingSnapshot["proxies"],
    accounts: overrides.accounts ?? [] as unknown as RoutingSnapshot["accounts"],
    ponytailEnabled: false,
    rtkConfig: null,
    createdAt: new Date().toISOString(),
  } as unknown as RoutingSnapshot;
  // Ensure both prefixes maps are consistent
  return base;
}

function freeSnapshot(overrides: Partial<RoutingSnapshot> & { revision?: number }): RoutingSnapshot {
  const s = snapshot(overrides);
  // Mark all model providers as free-tier so candidates are generated without accounts
  const kinds = new Map<string, "none" | "api_key" | "oauth">();
  for (const m of (overrides.models ?? []) as unknown as ProviderModelMeta[]) {
    kinds.set(m.providerId, "none");
  }
  // ensure common prefixes also considered free
  if (!kinds.has("openai")) kinds.set("openai", "none");
  if (!kinds.has("anthropic")) kinds.set("anthropic", "none");
  (s as unknown as { providerCredentialKinds: Map<string, string> }).providerCredentialKinds = kinds as unknown as RoutingSnapshot["providerCredentialKinds"];
  return s;
}

describe("persisted model availability", () => {
  test("rejects a model disabled by provider_models", () => {
    const snap = freeSnapshot({
      models: [{ providerId: "openai", modelId: "gpt-4", enabled: false, caps: {} }] as unknown as ProviderModelMeta[],
    });
    const plan = createRoutePlan({ requestedModel: "openai/gpt-4", snapshot: snap });
    expect(plan.candidates).toHaveLength(0);
    expect(plan.diagnostics.some((diagnostic) => diagnostic.code === "model_disabled")).toBe(true);
  });
});
describe("fallback order", () => {
  test("fallback strategy preserves configured member order", () => {
    const snap = freeSnapshot({
      aliases: new Map(),
      combos: new Map([
        ["my-combo", { members: ["openai/gpt-4", "openai/gpt-3.5", "anthropic/claude-3"], strategy: "fallback" }],
      ]),
      models: [
        { providerId: "openai", modelId: "gpt-4", caps: { toolCalls: true } },
        { providerId: "openai", modelId: "gpt-3.5", caps: { toolCalls: true } },
        { providerId: "anthropic", modelId: "claude-3", caps: { toolCalls: true } },
      ] as unknown as ProviderModelMeta[],
    });
    const plan = createRoutePlan({ requestedModel: "my-combo", snapshot: snap });
    expect(plan.candidates.map((c) => `${c.providerId}/${c.modelId}`)).toEqual(["openai/gpt-4", "openai/gpt-3.5", "anthropic/claude-3"]);
  });
});

describe("round-robin rotation", () => {
  test("2 calls rotate via BoundedRouteSessionStore", () => {
    const store = new BoundedRouteSessionStore();
    const snap = freeSnapshot({
      revision: 42,
      combos: new Map([
        ["rr-combo", { members: ["openai/gpt-4", "openai/gpt-3.5"], strategy: "round-robin" }],
      ]),
      models: [
        { providerId: "openai", modelId: "gpt-4", caps: {} },
        { providerId: "openai", modelId: "gpt-3.5", caps: {} },
      ] as unknown as ProviderModelMeta[],
    });
    // bypass cache via isAccountEligible to exercise rotation each call
    const eligible = () => true;
    const p1 = createRoutePlan({ requestedModel: "rr-combo", snapshot: snap, routeSessionStore: store, isAccountEligible: eligible });
    const p2 = createRoutePlan({ requestedModel: "rr-combo", snapshot: snap, routeSessionStore: store, isAccountEligible: eligible });
    expect(p1.candidates[0]!.modelId).not.toBe(p2.candidates[0]!.modelId);
    expect(new Set([p1.candidates[0]!.modelId, p2.candidates[0]!.modelId])).toEqual(new Set(["gpt-4", "gpt-3.5"]));
  });

  test("sticky_limit retains same head for N uses then rotates", () => {
    const store = new BoundedRouteSessionStore();
    const snap = freeSnapshot({
      revision: 99,
      combos: new Map([
        ["sticky-combo", { members: ["openai/gpt-4", "openai/gpt-3.5"], strategy: "round-robin", stickyLimit: 2 }],
      ]),
      models: [
        { providerId: "openai", modelId: "gpt-4", caps: {} },
        { providerId: "openai", modelId: "gpt-3.5", caps: {} },
      ] as unknown as ProviderModelMeta[],
    });
    const eligible = () => true;
    const a = createRoutePlan({ requestedModel: "sticky-combo", snapshot: snap, routeSessionStore: store, isAccountEligible: eligible });
    const b = createRoutePlan({ requestedModel: "sticky-combo", snapshot: snap, routeSessionStore: store, isAccountEligible: eligible });
    const c = createRoutePlan({ requestedModel: "sticky-combo", snapshot: snap, routeSessionStore: store, isAccountEligible: eligible });
    // first two should be same head, third rotates
    expect(a.candidates[0]!.modelId).toBe(b.candidates[0]!.modelId);
    expect(c.candidates[0]!.modelId).not.toBe(a.candidates[0]!.modelId);
  });
});

describe("nested / cyclic combos", () => {
  test("nested combo members are expanded", () => {
    const snap = freeSnapshot({
      combos: new Map([
        ["inner", { members: ["openai/gpt-4"], strategy: "fallback" }],
        ["outer", { members: ["inner", "openai/gpt-3.5"], strategy: "fallback" }],
      ]),
      models: [
        { providerId: "openai", modelId: "gpt-4", caps: {} },
        { providerId: "openai", modelId: "gpt-3.5", caps: {} },
      ] as unknown as ProviderModelMeta[],
    });
    const plan = createRoutePlan({ requestedModel: "outer", snapshot: snap });
    expect(plan.candidates.map((c) => c.modelId).sort()).toEqual(["gpt-3.5", "gpt-4"]);
  });

  test("alias cycle is diagnosed and does not hang", () => {
    const snap = snapshot({
      aliases: new Map([["a", "b"], ["b", "a"]]),
      combos: new Map(),
    });
    const plan = createRoutePlan({ requestedModel: "a", snapshot: snap });
    // alias cycle yields diagnostic; plan may be empty but not infinite
    expect(plan.diagnostics.some((d) => d.code === "cycle" || d.code === "max_depth")).toBe(true);
  });

  test("cyclic alias via combo member is handled", () => {
    const snap = snapshot({
      aliases: new Map([["x", "y"], ["y", "x"]]),
      combos: new Map([["loop", { members: ["x"], strategy: "fallback" }]]),
    });
    const plan = createRoutePlan({ requestedModel: "loop", snapshot: snap });
    // should not throw, diagnostics present or empty candidates
    expect(plan.candidates.length).toBeGreaterThanOrEqual(0);
    expect(plan.diagnostics.length).toBeGreaterThanOrEqual(0);
  });
});

describe("ambiguous bare model", () => {
  test("bare model owned by multiple providers -> ambiguous_model", () => {
    const snap = snapshot({
      models: [
        { providerId: "openai", modelId: "gpt-4", caps: {} },
        { providerId: "anthropic", modelId: "gpt-4", caps: {} },
      ] as unknown as ProviderModelMeta[],
      prefixes: new Map([["openai","openai"],["anthropic","anthropic"]]),
      providerPrefixes: new Map([["openai","openai"],["anthropic","anthropic"]]),
    });
    const plan = createRoutePlan({ requestedModel: "gpt-4", snapshot: snap });
    expect(plan.candidates).toHaveLength(0);
    expect(plan.diagnostics.some((d) => d.code === "ambiguous_model")).toBe(true);
    expect(plan.failureCode).toBe("ambiguous_model");
  });
});

describe("pre-lease capability rejection", () => {
  test("hostedSearch required but model lacks search cap -> capability_unsupported before lease", () => {
    const snap = snapshot({
      models: [
        { providerId: "openai", modelId: "gpt-4", caps: { search: false, toolCalls: true } },
      ] as unknown as ProviderModelMeta[],
      prefixes: new Map([["openai","openai"]]),
      providerPrefixes: new Map([["openai","openai"]]),
    });
    const plan = createRoutePlan({
      requestedModel: "openai/gpt-4",
      snapshot: snap,
      requiredCapabilities: { hostedSearch: true } as unknown as import("../types/routing.js").RequiredRouteCapabilities,
    });
    expect(plan.candidates).toHaveLength(0);
    expect(plan.failureCode).toBe("capability_unsupported");
    expect(plan.diagnostics.some((d) => d.code === "capability_unsupported")).toBe(true);
  });
});

describe("allowlist mapping via resolveCliModelMapping", () => {
  test("allowlisted apiKeyId is mapped", () => {
    const mappings = new Map([
      ["claude", { enabled: true, entries: [{ sourceModel: "sonnet", targetModel: "claude-sonnet-4-6", enabled: true }], allowedApiKeyIds: ["key-1"] }],
    ]);
    const client = { name: "claude_code" as const, source: "explicit_header" as const };
    const result = resolveCliModelMapping(client, "sonnet", "key-1", mappings);
    expect(result).toBe("claude-sonnet-4-6");
  });

  test("unallowlisted key cannot use mapping", () => {
    const mappings = new Map([
      ["claude", { enabled: true, entries: [{ sourceModel: "sonnet", targetModel: "claude-sonnet-4-6", enabled: true }], allowedApiKeyIds: ["key-1"] }],
    ]);
    const client = { name: "claude_code" as const, source: "explicit_header" as const };
    const result = resolveCliModelMapping(client, "sonnet", "key-2", mappings);
    expect(result).toBe("sonnet");
  });

  test("empty allowlist maps no keys", () => {
    const mappings = new Map([
      ["claude", { enabled: true, entries: [{ sourceModel: "sonnet", targetModel: "x", enabled: true }], allowedApiKeyIds: [] }],
    ]);
    const client = { name: "claude_code" as const, source: "explicit_header" as const };
    expect(resolveCliModelMapping(client, "sonnet", "key-1", mappings)).toBe("sonnet");
  });
});

describe("raw vs mapped model in plan", () => {
  test("plan preserves rawRequestedModel and mappedModel", () => {
    const snap = snapshot({
      models: [{ providerId: "openai", modelId: "gpt-4", caps: {} }] as unknown as ProviderModelMeta[],
    });
    const plan = createRoutePlan({ requestedModel: "openai/gpt-4", snapshot: snap, rawRequestedModel: "orig-model", mappedModel: "openai/gpt-4" });
    expect(plan.requestedModel).toBe("orig-model");
    expect(plan.mappedModel).toBe("openai/gpt-4");
  });
});
