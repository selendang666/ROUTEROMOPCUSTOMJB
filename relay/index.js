const crypto = require("node:crypto");

const MAX_BODY_BYTES = 10 * 1024 * 1024;
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function safeEqual(expected, supplied) {
  if (typeof expected !== "string" || typeof supplied !== "string") return false;
  const expectedBuffer = Buffer.from(expected);
  const suppliedBuffer = Buffer.from(supplied);
  return expectedBuffer.length === suppliedBuffer.length && crypto.timingSafeEqual(expectedBuffer, suppliedBuffer);
}

function sendJson(response, status, payload) {
  if (response.writableEnded || response.destroyed) return;
  const body = Buffer.from(JSON.stringify(payload));
  response.writeHead(status, { "content-type": "application/json", "content-length": body.length });
  response.end(body);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    request.on("data", (chunk) => {
      length += chunk.length;
      if (length > MAX_BODY_BYTES) {
        reject(new Error("Request body is too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.once("end", () => resolve(Buffer.concat(chunks)));
    request.once("error", reject);
    request.once("aborted", () => reject(new Error("Request aborted")));
  });
}

function upstreamUrl(base, path) {
  const normalizedBase = base.replace(/\/$/, "");
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  if (normalizedBase.endsWith("/v1") && (normalizedPath === "/v1" || normalizedPath.startsWith("/v1/"))) {
    return `${normalizedBase.slice(0, -3)}${normalizedPath}`;
  }
  return `${normalizedBase}${normalizedPath}`;
}

function passthroughHeaders(request, apiKey) {
  const headers = {};
  for (const [name, value] of Object.entries(request.headers)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower) || lower === "host" || lower === "content-length" || lower === "cookie" || lower === "x-upstream-path" || lower === "x-relay-path" || lower === "x-relay-target" || lower === "x-relay-secret" || lower === "x-relay-id" || lower.startsWith("x-forwarded-") || lower.startsWith("x-vercel-")) continue;
    headers[name] = value;
  }
  headers.authorization = `Bearer ${apiKey}`;
  return headers;
}

function copyResponseHeaders(upstreamHeaders) {
  const headers = {};
  for (const [name, value] of upstreamHeaders) {
    if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase()) && name.toLowerCase() !== "content-length") headers[name] = value;
  }
  return headers;
}

function waitForDrain(response) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      response.off("drain", onDrain);
      response.off("error", onError);
      response.off("close", onClose);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("Relay client disconnected"));
    };
    response.once("drain", onDrain);
    response.once("error", onError);
    response.once("close", onClose);
  });
}

function createHandler(options = {}) {
  const env = options.env ?? process.env;
  const baseRelayId = options.relayId ?? env.RELAY_ID ?? crypto.randomUUID();
  return async function handler(request, response) {
    if (request.method !== "POST") {
      response.setHeader("allow", "POST");
      sendJson(response, 405, { error: { message: "Method not allowed", type: "invalid_request_error" } });
      return;
    }
    if (typeof env.RELAY_SECRET !== "string" || env.RELAY_SECRET.length < 8 || !safeEqual(env.RELAY_SECRET, request.headers["x-relay-secret"])) {
      sendJson(response, 401, { error: { message: "Invalid relay secret", type: "invalid_request_error" } });
      return;
    }
    const requestedTarget = request.headers["x-relay-target"];
    const allowedTargets = (env.ALLOWED_UPSTREAM_TARGETS ?? env.UPSTREAM_BASE ?? "").split(",").map((value) => value.trim().replace(/\/$/, "")).filter(Boolean);
    const target = typeof requestedTarget === "string" ? requestedTarget.trim().replace(/\/$/, "") : env.UPSTREAM_BASE;
    if (typeof target !== "string" || !allowedTargets.includes(target)) {
      sendJson(response, 403, { error: { message: "Upstream target is not allowed", type: "permission_error" } });
      return;
    }
    let targetUrl;
    try {
      targetUrl = new URL(target);
      if (targetUrl.protocol !== "https:" && targetUrl.protocol !== "http:") throw new Error("unsupported protocol");
      if (targetUrl.username.length > 0 || targetUrl.password.length > 0) throw new Error("credentials are not allowed");
    } catch {
      sendJson(response, 400, { error: { message: "Invalid upstream target", type: "invalid_request_error" } });
      return;
    }
    const path = request.headers["x-upstream-path"] ?? request.headers["x-relay-path"];
    if (typeof path !== "string" || !path.startsWith("/v1/") || path.includes("..") || /[\r\n]/.test(path)) {
      sendJson(response, 400, { error: { message: "Invalid upstream path", type: "invalid_request_error" } });
      return;
    }
    if (!env.UPSTREAM_API_KEY) {
      sendJson(response, 500, { error: { message: "Relay is not configured", type: "server_error" } });
      return;
    }
    let body;
    try {
      body = await readBody(request);
    } catch {
      if (!response.destroyed) sendJson(response, 400, { error: { message: "Invalid request body", type: "invalid_request_error" } });
      return;
    }
    const controller = new AbortController();
    const abortUpstream = () => controller.abort(new Error("Relay client disconnected"));
    request.once("aborted", abortUpstream);
    response.once("close", () => {
      if (!response.writableEnded) abortUpstream();
    });
    let upstreamResponse;
    try {
      upstreamResponse = await fetch(upstreamUrl(target, path), {
        method: "POST",
        headers: passthroughHeaders(request, env.UPSTREAM_API_KEY),
        body,
        redirect: "manual",
        signal: controller.signal,
      });
    } catch {
      request.off("aborted", abortUpstream);
      if (!controller.signal.aborted && !response.destroyed) sendJson(response, 502, { error: { message: "Upstream fetch failed", type: "upstream_error" } });
      return;
    }
    const headers = copyResponseHeaders(upstreamResponse.headers);
    headers["x-relay-id"] = `${baseRelayId}-${crypto.randomUUID()}`;
    response.writeHead(upstreamResponse.status, headers);
    if (!upstreamResponse.body) {
      request.off("aborted", abortUpstream);
      response.end();
      return;
    }
    try {
      for await (const chunk of upstreamResponse.body) {
        if (!response.write(Buffer.from(chunk))) await waitForDrain(response);
      }
      if (!response.writableEnded) response.end();
    } catch {
      if (!controller.signal.aborted && !response.destroyed && !response.writableEnded) response.destroy();
    } finally {
      request.off("aborted", abortUpstream);
    }
  };
}

const handler = createHandler();
module.exports = handler;
module.exports.createHandler = createHandler;
module.exports.default = handler;
