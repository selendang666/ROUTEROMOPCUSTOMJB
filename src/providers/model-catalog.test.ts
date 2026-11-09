import { expect, test } from "bun:test";
import { capabilitiesOf, modelOf } from "../proxy/types/provider.js";
import { mergeProviderModels } from "./model-catalog.js";

const capabilities = capabilitiesOf({ surfaces: ["openai-chat"] });

test("provider model catalog retains fallback and selects largest discovered context window", () => {
  const staticModels = [
    modelOf("stable", "Stable", capabilities, { context: { inputTokens: 272_000, outputTokens: 32_000 } }),
  ];
  const discovered = [
    modelOf("stable", "Stable", capabilities, { upstreamId: "stable-wm", context: { inputTokens: 1_000_000, outputTokens: 128_000 } }),
    modelOf("new", "New", capabilities, { context: { inputTokens: 372_000, outputTokens: 64_000 } }),
  ];
  const merged = mergeProviderModels(staticModels, [discovered]);
  expect(merged).toHaveLength(2);
  expect(merged.find((model) => model.id === "stable")?.context?.inputTokens).toBe(1_000_000);
  expect(merged.find((model) => model.id === "stable")?.upstreamId).toBe("stable-wm");
  expect(merged.find((model) => model.id === "new")?.context?.inputTokens).toBe(372_000);
});
