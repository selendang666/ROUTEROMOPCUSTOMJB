import { describe, expect, test } from "bun:test";
import { fetchOllamaQuota } from "./ollama.js";

describe("Ollama Cloud quota", () => {
  test("maps session and weekly usage ratios to percentage windows", async () => {
    const fetcher = (async (input: string | URL | Request) => {
      if (String(input).endsWith("/api/me")) {
        return new Response(JSON.stringify({ Plan: "pro" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ limits: { session: { usage: 0.25 }, weekly: { usage: "0.5" } } }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    await expect(fetchOllamaQuota("ollama-key", fetcher)).resolves.toMatchObject({
      source: "ollama",
      plan: "Pro",
      windows: [
        { kind: "session", label: "Session (5h)", usedPercent: 25, remainingPercent: 75 },
        { kind: "weekly", label: "Weekly (7d)", usedPercent: 50, remainingPercent: 50 },
      ],
      error: null,
    });
  });
});
