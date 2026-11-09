import { describe, expect, test } from "bun:test";
import {
  applyProviderQuirkPolicy,
  applyResponsesToolCloak,
  finalAnthropicCacheAnchors,
  mapGeminiToolName,
  normalizeGeminiRole,
  projectReasoningOutputTokens,
} from "./projection.js";
import { providerQuirkPolicy } from "./profiles.js";
import type { CachePlan } from "../translate/cache.js";
import type { ProviderQuirkPolicy } from "../types/provider.js";

describe("provider quirk projection", () => {
  test("drops and clamps payload fields without mutating the input", () => {
    const policy = { droppedFields: ["drop"], clampedFields: { temperature: { min: 0, max: 1 } } } as unknown as ProviderQuirkPolicy;
    const input = { drop: true, temperature: 2, keep: "ok" };
    expect(applyProviderQuirkPolicy(input, policy)).toEqual({ temperature: 1, keep: "ok" });
    expect(input).toEqual({ drop: true, temperature: 2, keep: "ok" });
  });

  test("normalizes gemini roles and tool names", () => {
    const gemini = providerQuirkPolicy("gemini");
    expect(normalizeGeminiRole("system", gemini)).toBe("user");
    expect(normalizeGeminiRole("assistant", gemini)).toBe("model");
    expect(mapGeminiToolName("tool name?!", gemini)).toBe("tool_name__");
  });

  test("cloaks OpenCode Responses tools while preserving client tools", () => {
    const opencode = providerQuirkPolicy("opencodeft");
    const input = {
      model: "muse-spark-1.3-contributor-free",
      tools: [{ type: "function", name: "get_weather", parameters: { type: "object" } }],
    };
    const result = applyResponsesToolCloak(input, opencode);
    expect(result).not.toBe(input);
    expect(result.tool_choice).toBe("auto");
    expect((result.tools as Array<{ name: string }>).map((tool) => tool.name)).toEqual(["get_weather", "bash", "read"]);
    expect(input.tools).toHaveLength(1);
  });

  test("does not duplicate OpenCode decoys and handles empty tools", () => {
    const opencode = providerQuirkPolicy("opencodeft");
    const withDecoys = applyResponsesToolCloak({
      model: "muse-spark-1.2-contributor-free",
      tools: [
        { type: "function", name: "bash", parameters: { type: "object" } },
        { type: "function", name: "read", parameters: { type: "object" } },
      ],
    }, opencode);
    expect((withDecoys.tools as Array<{ name: string }>).map((tool) => tool.name)).toEqual(["bash", "read"]);
    const empty = applyResponsesToolCloak({ model: "muse-spark-1.3-contributor-free", tools: [] }, opencode);
    expect((empty.tools as Array<{ name: string }>).map((tool) => tool.name)).toEqual(["bash", "read"]);
    expect(empty.tool_choice).toBe("auto");
  });

  test("cloaks a large external tool set without dropping tools", () => {
    const opencode = providerQuirkPolicy("opencodeft");
    const tools = Array.from({ length: 46 }, (_, index) => ({
      type: "function",
      name: `external_tool_${index}`,
      parameters: { type: "object", properties: {} },
    }));
    const result = applyResponsesToolCloak({ model: "muse-spark-1.3-contributor-free", tools }, opencode);
    expect(result.tool_choice).toBe("auto");
    expect(result.tools).toHaveLength(48);
    const names = new Set((result.tools as Array<{ name: string }>).map((tool) => tool.name));
    expect(names.has("external_tool_0")).toBe(true);
    expect(names.has("external_tool_45")).toBe(true);
    expect(names.has("bash")).toBe(true);
    expect(names.has("read")).toBe(true);
  });

  test("leaves non-Muse OpenCode Responses payloads unchanged", () => {
    const opencode = providerQuirkPolicy("opencodeft");
    const input = { model: "big-pickle", tools: [{ type: "function", name: "lookup" }] };
    expect(applyResponsesToolCloak(input, opencode)).toEqual(input);
  });

  test("projects reasoning token budgets through policy and model caps", () => {
    const gemini = providerQuirkPolicy("gemini");
    expect(projectReasoningOutputTokens(4, true, gemini, 32)).toBe(16);
    expect(projectReasoningOutputTokens(9_000, true, gemini, 1_000)).toBe(1_000);
    expect(projectReasoningOutputTokens(4, false, gemini, 32)).toBe(4);
  });

  test("adds Anthropic cache anchors for system, tools, and history", () => {
    const claude = providerQuirkPolicy("claude");
    const plan = {
      sections: [],
      toolsStable: true,
      hasStablePrefix: true,
      prefixEndMessageIndex: 2,
      prefixEndBlockIndex: 0,
      prefixFingerprint: "prefix",
    } as CachePlan;
    const payload = {
      system: "Stay concise.",
      tools: [{ type: "tool", name: "lookup", description: "Lookup data.", inputSchema: { type: "object" } }],
      messages: [
        { role: "user", content: [{ type: "text", text: "Hello" }] },
        { role: "assistant", content: [{ type: "text", text: "Reply" }] },
        { role: "user", content: [{ type: "text", text: "Last stable turn" }] },
      ],
    };
    const result = finalAnthropicCacheAnchors(payload, plan, claude);
    expect(result).not.toBe(payload);
    expect(result.system).toEqual([
      expect.objectContaining({ text: "Stay concise.", cache_control: { type: "ephemeral", ttl: "1h" } }),
    ]);
    expect(result.tools).toEqual([
      expect.objectContaining({ name: "lookup", cache_control: { type: "ephemeral", ttl: "1h" } }),
    ]);
    expect(result.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "user" }),
        expect.objectContaining({ role: "assistant" }),
        expect.objectContaining({
          role: "user",
          content: [expect.objectContaining({ text: "Last stable turn", cache_control: { type: "ephemeral", ttl: "5m" } })],
        }),
      ]),
    );
  });
});
