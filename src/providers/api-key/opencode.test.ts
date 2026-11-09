import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { buildOpenCodeHeaders, OpenCodeFreeProvider, OpenCodeZenProvider } from "./opencode.js";

test("keeps only supported OpenCode Free models in Free and Zen catalogs", () => {
  const freeModels = new OpenCodeFreeProvider().models.list.map((model) => model.id);
  const zenModels = new OpenCodeZenProvider().models.list.map((model) => model.id);

  expect(freeModels).not.toContain("north-mini-code-free");
  expect(freeModels).not.toContain("x-preview-f-free");
  expect(zenModels).not.toContain("north-mini-code-free");
  expect(zenModels).not.toContain("x-preview-f-free");
});

test("keeps Muse on Responses while other OpenCode Free models use Chat", () => {
  const provider = new OpenCodeFreeProvider();

  expect(provider.models.get("muse-spark-1.2-contributor-free")?.capabilities.surfaces).toEqual(["openai-responses"]);
  expect(provider.models.get("big-pickle")?.capabilities.surfaces).toEqual(["openai-chat"]);
});

test("builds rotating Chrome identities with matching client hints", () => {
  const first = buildOpenCodeHeaders({ stream: true, publicAccess: true, path: "/v1/chat/completions", userAgentIndex: 0 });
  const second = buildOpenCodeHeaders({ stream: true, publicAccess: true, path: "/v1/chat/completions", userAgentIndex: 1 });

  expect(first["user-agent"]).toContain("Chrome/131");
  expect(first["sec-ch-ua"]).toContain('"Google Chrome";v="131"');
  expect(first["sec-ch-ua-platform"]).toBe('"Windows"');
  expect(second["user-agent"]).toContain("Chrome/132");
  expect(second["sec-ch-ua"]).toContain('"Google Chrome";v="132"');
  expect(second["sec-ch-ua-platform"]).toBe('"macOS"');
  expect(first.accept).toBe("text/event-stream");
  expect(first["sec-fetch-mode"]).toBe("cors");
});

test("uses configured upstream origin and safe extra headers", () => {
  const headers = buildOpenCodeHeaders({
    stream: false,
    publicAccess: false,
    credential: "secret-key",
    path: "/v1/responses",
    origin: "https://console.example/path",
    extraHeadersJson: JSON.stringify({
      "x-tenant": "tenant-a",
      authorization: "must-not-override",
      "x-invalid\nname": "ignored",
    }),
  });

  expect(headers.origin).toBe("https://console.example");
  expect(headers.referer).toBe("https://console.example/");
  expect(headers["x-tenant"]).toBe("tenant-a");
  expect(headers.authorization).toBe("Bearer secret-key");
  expect(headers["x-invalid\nname"]).toBeUndefined();
});

test("fills signature templates with bounded HMAC values", () => {
  const seed = "signature-seed";
  const path = "/v1/chat/completions";
  const headers = buildOpenCodeHeaders({
    stream: false,
    publicAccess: true,
    path,
    nowSeconds: 1_700_000_000,
    signatureSeed: seed,
    extraHeadersJson: JSON.stringify({
      "x-signature": "hmac-sha256",
      "x-signature-timestamp": "{{timestamp}}",
      "x-signature-expires": "{{exp}}",
    }),
    userAgentIndex: 0,
  });
  const expected = createHmac("sha256", seed).update(`POST\n${path}\n1700000000`).digest("hex");

  expect(headers["x-signature"]).toBe(expected);
  expect(headers["x-signature-timestamp"]).toBe("1700000000");
  expect(headers["x-signature-expires"]).toBe("1700000300");
});

test("omits signature headers when no seed is configured", () => {
  const headers = buildOpenCodeHeaders({
    stream: false,
    publicAccess: true,
    path: "/v1/chat/completions",
    extraHeadersJson: JSON.stringify({ "x-signature": "hmac-sha256" }),
    userAgentIndex: 0,
  });

  expect(headers["x-signature"]).toBeUndefined();
});
