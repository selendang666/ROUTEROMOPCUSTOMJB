import { describe, expect, test } from "bun:test";
import { resolveCliModelMapping, type CliModelMappingSnapshot } from "./mapping.js";
import type { ClientIdentity } from "../types/request.js";

function client(name: ClientIdentity["name"]): ClientIdentity {
  return { name, source: "explicit_header" };
}

function mappings(entries: Record<string, CliModelMappingSnapshot>): ReadonlyMap<string, CliModelMappingSnapshot> {
  return new Map(Object.entries(entries));
}

describe("resolveCliModelMapping — any-CLI (unclamped)", () => {
  test("codex mapping now routes (previously dead)", () => {
    const m = mappings({
      codex: { enabled: true, entries: [{ sourceModel: "gpt-5-codex", targetModel: "claude-opus", enabled: true }] },
    });
    expect(resolveCliModelMapping(client("codex"), "gpt-5-codex", m)).toBe("claude-opus");
  });

  test("opencode exact-match mapping routes", () => {
    const m = mappings({
      opencode: { enabled: true, entries: [{ sourceModel: "big", targetModel: "sonnet", enabled: true }] },
    });
    expect(resolveCliModelMapping(client("opencode"), "big", m)).toBe("sonnet");
  });

  test("gemini_cli mapping routes", () => {
    const m = mappings({
      "gemini-cli": { enabled: true, entries: [{ sourceModel: "gemini-3-flash", targetModel: "gpt-oss-120b", enabled: true }] },
    });
    expect(resolveCliModelMapping(client("gemini_cli"), "gemini-3-flash", m)).toBe("gpt-oss-120b");
  });

  test("claude keeps family-aware matcher", () => {
    const m = mappings({
      claude: { enabled: true, entries: [{ sourceModel: "sonnet", targetModel: "claude-sonnet-4-6", enabled: true }] },
    });
    expect(resolveCliModelMapping(client("claude_code"), "claude-3-5-sonnet", m)).toBe("claude-sonnet-4-6");
  });

  test("disabled settings passthrough", () => {
    const m = mappings({
      codex: { enabled: false, entries: [{ sourceModel: "gpt-5-codex", targetModel: "x", enabled: true }] },
    });
    expect(resolveCliModelMapping(client("codex"), "gpt-5-codex", m)).toBe("gpt-5-codex");
  });

  test("unknown client passthrough", () => {
    const m = mappings({ codex: { enabled: true, entries: [] } });
    expect(resolveCliModelMapping(client("unknown"), "anything", m)).toBe("anything");
  });

  test("no matching entry passthrough", () => {
    const m = mappings({
      codex: { enabled: true, entries: [{ sourceModel: "other", targetModel: "x", enabled: true }] },
    });
    expect(resolveCliModelMapping(client("codex"), "gpt-5-codex", m)).toBe("gpt-5-codex");
  });
});
