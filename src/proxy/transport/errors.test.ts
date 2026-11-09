import { expect, test } from "bun:test";
import { parseUpstreamFailure } from "./errors.js";
import { normalizeInternalFailure } from "../types/error-types.js";

test("classifies an unstructured proxied HTTP 400 as retryable proxy failure", async () => {
  const response = new Response("BAD_REQUEST", {
    status: 400,
    headers: { "x-ohmyomop-router-proxied": "1" },
  });

  await expect(parseUpstreamFailure(response)).rejects.toMatchObject({
    kind: "network_unavailable",
    retryable: true,
    routeScope: "proxy",
  });
});

test("preserves a structured provider HTTP 400 as an invalid request", async () => {
  const response = new Response(JSON.stringify({ error: { message: "unsupported control" } }), {
    status: 400,
    headers: { "content-type": "application/json", "x-ohmyomop-router-proxied": "1" },
  });

  await expect(parseUpstreamFailure(response)).rejects.toMatchObject({
    kind: "invalid_request",
    retryable: false,
    routeScope: null,
  });
});

test("classifies a Cloudflare block through a proxy as retryable proxy failure", async () => {
  const response = new Response("Attention Required! Cloudflare: Sorry, you have been blocked", {
    status: 403,
    headers: { "x-ohmyomop-router-proxied": "1" },
  });

  await expect(parseUpstreamFailure(response)).rejects.toMatchObject({
    kind: "network_unavailable",
    retryable: true,
    routeScope: "proxy",
  });
});

test("presents proxy failures with Oh My Omop - Router-specific context", () => {
  const error = normalizeInternalFailure({
    kind: "network_unavailable",
    statusCode: 400,
    retryable: true,
    routeScope: "proxy",
    source: "upstream",
    safeMessage: "proxy rejected request",
    retryAt: null,
  });

  expect(error.safeMessage).toBe("Oh My Omop - Router proxy error (HTTP 400)");
});

test("preserves upstream failure messages when they are already specific", () => {
  const error = normalizeInternalFailure({
    kind: "provider_unavailable",
    statusCode: 503,
    retryable: true,
    routeScope: null,
    source: "upstream",
    safeMessage: "Provider returned HTTP 503: upstream paused",
    retryAt: null,
    upstream: { providerId: "anthropic", transport: "http", statusCode: 503, providerCode: "provider_unavailable", providerType: "error", requestId: "req-1", retryAfterMs: null, bodyTruncated: false },
  });

  expect(error.safeMessage).toBe("Provider returned HTTP 503: upstream paused");
});
