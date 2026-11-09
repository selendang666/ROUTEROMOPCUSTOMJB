import type { ProviderRegistry } from "../../providers/registry.js";
import type { Surface } from "../../proxy/types/surface.js";
import type { PostgresPool } from "../../persistence/pool.js";
import { decryptWithKey, resolveEncryptionKey } from "../../persistence/crypto.js";
import type { TelemetryPipeline } from "../../persistence/telemetry/pipeline.js";
import type { ProviderUsage } from "../../proxy/types/telemetry.js";
import { resolveModelWireSurface } from "../../proxy/translate/policy.js";
import { NetworkSelector } from "../../proxy/transport/network.js";

export interface ProbeRequest {
  readonly provider: string;
  readonly model: string;
  readonly credentialMode?: "auto" | "account";
  readonly accountId?: string;
}

export interface ProbeServiceResult {
  readonly ok: boolean;
  readonly status: number;
  readonly code?: string;
  readonly message?: string;
  readonly data?: unknown;
}

export interface ProbeService {
  test(body: unknown): Promise<ProbeServiceResult>;
}

const HIDDEN_PROBE_TYPES = new Set([
  "analysis",
  "reasoning",
  "reasoning_delta",
  "reasoning_content",
  "redacted_thinking",
  "thinking",
  "thinking_delta",
]);

function visibleProbeText(value: unknown): string {
  if (typeof value === "string") {
    const cleaned = value
      .replace(/<think(?:ing)?[^>]*>[\s\S]*?<\/think(?:ing)?>/gi, "")
      .replace(/<reasoning[^>]*>[\s\S]*?<\/reasoning>/gi, "")
      .replace(/<analysis[^>]*>[\s\S]*?<\/analysis>/gi, "");
    const trimmed = cleaned.trim();
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (typeof parsed === "object" && parsed !== null) return visibleProbeText(parsed);
      } catch {
        // Keep non-JSON assistant text unchanged.
      }
    }
    return cleaned;
  }
  if (Array.isArray(value)) return value.map(visibleProbeText).join("");
  if (typeof value !== "object" || value === null) return "";

  const record = value as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type.toLowerCase() : "";
  if (HIDDEN_PROBE_TYPES.has(type) || type.includes("thinking") || type.includes("reasoning") || record.thought === true || record.is_thinking === true) return "";
  if (typeof record.output_text === "string") return visibleProbeText(record.output_text);
  if ("content" in record) return visibleProbeText(record.content);
  if (typeof record.text === "string") return visibleProbeText(record.text);
  if ("message" in record) return visibleProbeText(record.message);
  if ("delta" in record) return visibleProbeText(record.delta);
  return "";
}

function extractVisibleProbeText(body: Record<string, unknown>): string {
  const choices = body.choices;
  if (Array.isArray(choices)) {
    const firstChoice = choices[0];
    const text = visibleProbeText(firstChoice);
    if (text) return text;
  }
  if (typeof body.output_text === "string") {
    const text = visibleProbeText(body.output_text);
    if (text) return text;
  }
  if ("output" in body) {
    const text = visibleProbeText(body.output);
    if (text) return text;
  }
  return visibleProbeText(body.content);
}

export function createProbeService(
  registry: ProviderRegistry,
  getAccountCredential: (accountId: string) => Promise<string | null>,
  pool?: PostgresPool,
  telemetry?: TelemetryPipeline,
): ProbeService {
  const network = new NetworkSelector({
    getProxies: async () => {
      if (pool === undefined) return [];
      try {
        const rows = (await pool`
          SELECT id, protocol, host, port, priority, weight
          FROM proxies
          WHERE active = true AND last_test_error IS NULL
          ORDER BY priority, name, id
        `) as unknown as Array<Record<string, unknown>>;
        return rows.flatMap((row) => {
          const protocol = String(row.protocol ?? "");
          const port = Number(row.port);
          if ((protocol !== "http" && protocol !== "https" && protocol !== "socks5") || !Number.isInteger(port) || port < 1 || port > 65_535) return [];
          const host = String(row.host ?? "").trim();
          if (host.length === 0) return [];
          return [{
            id: String(row.id),
            url: `${protocol}://${host}:${port}`,
            priority: Number(row.priority ?? 100),
            weight: Number(row.weight ?? 100),
          }];
        });
      } catch {
        return [];
      }
    },
  });
  return {
    async test(body: unknown): Promise<ProbeServiceResult> {
      const v = (body ?? {}) as Record<string, unknown>;
      const provider = String(v.provider ?? "");
      const model = String(v.model ?? v.modelId ?? "");
      const accountId = typeof v.accountId === "string" ? v.accountId : undefined;
      let selectedAccountId: string | null = accountId ?? null;
      if (!provider || !model) {
        return { ok: false, status: 400, code: "invalid_request", message: "provider and model required" };
      }
      const adapter = registry.get(provider);
      if (!adapter) {
        return { ok: false, status: 404, code: "model_not_found", message: `provider ${provider} not found` };
      }
      let credential: string | null = null;
      const isNoAuth = adapter.metadata.credentialKind === "none";
      if (isNoAuth) {
        // Public providers intentionally do not require a persisted account or credential.
        credential = "";
      } else if (accountId) {
        credential = await getAccountCredential(accountId);
        if (!credential) {
          return { ok: false, status: 404, code: "model_not_found", message: `account ${accountId} not found` };
        }
      } else if (pool) {
        // Auto mode: find any active account for this provider
        try {
          const rows = (await pool`SELECT id, credential_encrypted FROM provider_accounts WHERE provider = ${provider} AND active = true ORDER BY priority LIMIT 1`) as unknown as Array<{ id: string; credential_encrypted: string }>;
          const row = rows[0];
          if (row) {
            selectedAccountId = row.id;
            try {
              credential = decryptWithKey(row.credential_encrypted, resolveEncryptionKey());
            } catch {
              credential = row.credential_encrypted;
            }
          }
        } catch {}
        if (!credential) {
          return { ok: false, status: 400, code: "invalid_request", message: `no credential found for provider ${provider} — add an account or provide accountId` };
        }
      } else {
        credential = await getAccountCredential(provider).catch(() => null);
        if (!credential) {
          return { ok: false, status: 400, code: "invalid_request", message: `no credential found for provider ${provider} — add an account or provide accountId` };
        }
      }
      const modelId = model.startsWith(`${provider}/`) ? model.slice(provider.length + 1) : model;
      const surface = resolveModelWireSurface(
        adapter.metadata,
        adapter.capabilities,
        adapter.models.get(modelId)?.capabilities ?? null,
        "openai-responses" as Surface,
      );
      if (surface === null) {
        return { ok: false, status: 400, code: "invalid_request", message: `provider ${provider} has no compatible surface for model ${model}` };
      }
      let target;
      try {
        target = adapter.resolveTarget(model, surface);
      } catch (error) {
        return { ok: false, status: 400, code: "invalid_request", message: error instanceof Error ? error.message : String(error) };
      }
      const traceId = crypto.randomUUID();
      const selectedNetwork = await network.select({ providerId: provider, affinityKey: `probe:${provider}` });
      const started = Date.now();
      const startedAt = new Date(started).toISOString();
      const writeConsoleLog = (event: "incoming" | "complete" | "failed" | "aborted", statusCode: number | null, errorKind: string | null, durationMs: number, usage: ProviderUsage | null): void => {
        if (telemetry === undefined || typeof telemetry.writeLogs !== "function") return;
        const context = {
          event,
          requestId: traceId,
          endpoint: "/console/api/probe",
          surface: "probe",
          providerId: provider,
          model,
          status: event === "aborted" ? 499 : statusCode,
          errorKind,
          durationMs,
          inputTokens: usage?.inputTokens ?? usage?.promptTokens ?? null,
          outputTokens: usage?.outputTokens ?? usage?.completionTokens ?? null,
          cachedTokens: usage?.cacheReadTokens ?? usage?.cachedTokens ?? null,
          cacheWriteTokens: usage?.cacheWriteTokens ?? null,
          reasoningTokens: usage?.reasoningTokens ?? null,
          messageCount: 2,
          toolCount: 0,
          imageCount: 0,
          clientName: "console_probe",
          clientSource: "console",
          clientIp: null,
          accountId: selectedAccountId,
          proxyId: selectedNetwork?.proxyId ?? null,
        };
        const route = `${provider}/${model}`;
        const request = `req=${traceId.slice(0, 8)}`;
        let message: string;
        let level: "debug" | "info" | "warn" | "error";
        if (event === "incoming") {
          message = `Incoming Request: POST /console/api/probe · ${request} · ${route} · account=${selectedAccountId ?? "none"}`;
          level = "debug";
        } else if (event === "complete") {
          message = `Request Complete: ${statusCode ?? 200} · ${request} · ${route} · account=${selectedAccountId ?? "none"} · proxy=${selectedNetwork?.proxyId ?? "direct"} · ${durationMs}ms`;
          level = "info";
        } else if (event === "aborted") {
          message = `Response Aborted by Client: 499 · ${request} · ${route} · account=${selectedAccountId ?? "none"} · ${durationMs}ms`;
          level = "warn";
        } else {
          message = `Request Failed: ${statusCode ?? 502} · ${request} · ${route} · error=${errorKind ?? "unknown"} · ${durationMs}ms`;
          level = "error";
        }
        void telemetry.writeLogs([{ level, scope: "request", msg: message, context }]).catch(() => {});
      };
      const recordTrace = (statusCode: number, errorKind: string | null, durationMs: number, usage: ProviderUsage | null): void => {
        telemetry?.enqueue({
          requestId: traceId,
          endpoint: "/console/api/probe",
          surface: "probe",
          model,
          providerId: provider,
          clientName: "console_probe",
          clientSource: "console",
          method: "POST",
          path: "/console/api/probe",
          safeHeaders: {
            "x-ohmyomop-router-probe": "true",
            "x-ohmyomop-router-route": selectedNetwork?.proxyId === null ? "direct" : "proxy",
            "x-ohmyomop-router-proxy-id": selectedNetwork?.proxyId ?? "",
          },
          statusCode,
          errorKind,
          durationMs,
          usage,
          committed: false,
          startedAt,
          finishedAt: new Date().toISOString(),
        });
        let event: "complete" | "failed" | "aborted";
        if (statusCode === 0 || errorKind === "client_aborted") event = "aborted";
        else if (statusCode >= 400 || errorKind !== null) event = "failed";
        else event = "complete";
        writeConsoleLog(event, statusCode, errorKind, durationMs, usage);
      };
      writeConsoleLog("incoming", null, null, 0, null);
      if (selectedNetwork === null) {
        const durationMs = Date.now() - started;
        recordTrace(503, "network_unavailable", durationMs, null);
        return {
          ok: false,
          status: 503,
          code: "network_unavailable",
          message: "No eligible proxy route available for probe",
          data: { ok: false, traceId, proxyId: null, latencyMs: durationMs },
        };
      }
      const request: Record<string, unknown> = {
        model,
        messages: [
          {
            role: "system",
            content: [
              {
                type: "text",
                text: "Be honest about your identity, creator, and knowledge cutoff. Be concise. Answer quickly.",
              },
            ],
          },
          {
            role: "user",
            content: [{ type: "text", text: "Halo siapa kamu" }],
          },
        ],
        tools: [],
        toolChoice: undefined,
        stream: false,
        maxTokens: 84,
        temperature: 0.2,
        limits: {
        connectTimeoutMs: 8000,
        firstByteTimeoutMs: 15000,
        idleTimeoutMs: 15000,
        totalTimeoutMs: 30000,
              },
      };
      const adapterRequest: Record<string, unknown> = {
        request,
        target,
        credential: credential ?? "",
        signal: AbortSignal.timeout(30000),
        network: { ...selectedNetwork.selection, proxyId: selectedNetwork.proxyId },
        capture: undefined,
      };
      try {
        const result = await (adapter.call as unknown as (req: unknown) => Promise<unknown>)(adapterRequest);
        const typed = result as { mode: string; body?: Record<string, unknown>; events?: AsyncIterable<unknown>; usage?: ProviderUsage | null };
        const latencyMs = Date.now() - started;
        let sample = "";
        if (typed.mode === "non_stream" && typeof typed.body === "object" && typed.body !== null) {
          const body = typed.body as Record<string, unknown>;
          sample = extractVisibleProbeText(body);
        } else if (typed.mode === "stream" && typed.events) {
          // Collect stream quickly
          let text = "";
          for await (const ev of typed.events as AsyncIterable<Record<string, unknown>>) {
            const visible = visibleProbeText(ev);
            if (visible) text += visible;
            if (text.length > 2000) break;
          }
          sample = text;
        }
        recordTrace(200, null, latencyMs, typed.usage ?? null);
        return {
          ok: true,
          status: 200,
          data: {
            ok: true,
            traceId,
            proxyId: selectedNetwork.proxyId,
            route: selectedNetwork.proxyId === null ? "direct" : "proxy",
            latencyMs,
            sample: sample.slice(0, 1000),
            returnedModel: (typed.body as { model?: string } | undefined)?.model ?? model,
          },
      };
      } catch (error) {
        const latencyMs = Date.now() - started;
        const mapped = adapter.mapError(error);
        const status = mapped.statusCode ?? 502;
        const msg = mapped.safeMessage;
        recordTrace(status, mapped.kind, latencyMs, null);
        return {
          // The console operation completed successfully; only the upstream
          // probe failed. This preserves data.ok for dashboard batch probes.
          ok: true,
          // Provider failures are probe data, not console authorization failures.
          // Returning their upstream HTTP status would make the dashboard's global
          // 401/403 handler navigate away while a batch probe is still running.
          status: 200,
          code: mapped.kind,
          message: msg,
          data: { ok: false, traceId, proxyId: selectedNetwork.proxyId, route: selectedNetwork.proxyId === null ? "direct" : "proxy", latencyMs, upstreamStatus: status, error: { message: msg } },
        };
      } finally {
        await selectedNetwork.selection.release?.().catch(() => {});
      }
    },
  };
}
