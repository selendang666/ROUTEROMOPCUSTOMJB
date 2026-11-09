import { describe, expect, test } from "bun:test";
import { fetchAntigravityQuota } from "./antigravity.js";

describe("Antigravity quota", () => {
  test("keeps current Gemini 3.6 and 3.7 quota families", async () => {
    const fetcher = (async () => new Response(JSON.stringify({
      models: {
        "gemini-3.6-flash-medium": { quotaInfo: { remainingFraction: 0.8, resetTime: "2030-01-01T00:00:00Z" } },
        "gemini-3.7-flash": { quotaInfo: { remainingFraction: 0.5, resetTime: "2030-01-01T00:00:00Z" } },
      },
    }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;

    const result = await fetchAntigravityQuota(JSON.stringify({ accessToken: "access", projectId: "project-1" }), undefined, fetcher);
    expect(result.error).toBeNull();
    expect(result.windows).toHaveLength(1);
    expect(result.windows[0]).toMatchObject({ label: "Google · Quota", usedPercent: 50, remainingPercent: 50 });
  });
});
