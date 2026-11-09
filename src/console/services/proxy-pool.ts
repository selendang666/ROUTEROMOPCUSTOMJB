import type { PostgresPool } from "../../persistence/pool.js";
import { buildProxyFetcher } from "../../proxy/transport/network.js";

/**
 * Proxies console service — verbatim from bootstrap 912-927.
 */
export function createProxiesService(pool: PostgresPool, onMutation: () => void = () => {}) {
  const testProxyEgress = async (protocol: string, host: string, port: number, timeoutMs = 10000): Promise<{ ok: boolean; latencyMs: number; error?: string; egressIp?: string }> => {
    const started = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const fetcher = buildProxyFetcher({ url: `${protocol}://${host}:${port}` });
      const response = await fetcher("https://api.ipify.org/?format=json", {
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
      if (!response.ok) return { ok: false, latencyMs: Date.now() - started, error: `egress health returned HTTP ${response.status}` };
      const payload: unknown = await response.json();
      if (typeof payload !== "object" || payload === null || typeof (payload as { ip?: unknown }).ip !== "string") {
        return { ok: false, latencyMs: Date.now() - started, error: "egress health returned invalid JSON" };
      }
      return { ok: true, latencyMs: Date.now() - started, egressIp: (payload as { ip: string }).ip };
    } catch (error) {
      return { ok: false, latencyMs: Date.now() - started, error: error instanceof Error ? error.message : "proxy health check failed" };
    } finally {
      clearTimeout(timeout);
    }
  };

  const testConnection = testProxyEgress;

  return {
    async list() {
      const rows = (await pool`
        SELECT id, name, protocol, is_relay, host, port, username, password_encrypted,
               priority, weight, max_concurrency, active,
               last_used_at, created_at, updated_at, last_test_at,
               last_test_success_at, last_test_success_latency_ms,
               last_test_error_at, last_test_error, last_test_status_code
        FROM proxies
        ORDER BY priority, name, id
      `) as unknown as Array<Record<string, unknown>>;
      return rows.map((row) => ({
        id: String(row.id),
        name: String(row.name),
        protocol: String(row.protocol),
        isRelay: row.is_relay === true,
        host: String(row.host),
        port: Number(row.port),
        username: row.username === null || row.username === undefined ? null : String(row.username),
        passwordHint: row.password_encrypted ? "configured" : null,
        maxConcurrency: Number(row.max_concurrency ?? 8),
        weight: Number(row.weight ?? 100),
        active: row.active === true,
        lastUsedAt: row.last_used_at ?? null,
        createdAt: row.created_at ?? null,
        updatedAt: row.updated_at ?? null,
        lastTestAt: row.last_test_at ?? null,
        lastTestSuccessAt: row.last_test_success_at ?? null,
        lastTestSuccessLatencyMs: row.last_test_success_latency_ms ?? null,
        lastTestErrorAt: row.last_test_error_at ?? null,
        lastTestError: row.last_test_error ?? null,
        lastTestStatusCode: row.last_test_status_code ?? null,
      }));
    },
    async create(body: unknown) {
      const v = (body ?? {}) as Record<string, unknown>;
      const id = typeof v.id === "string" ? v.id : crypto.randomUUID();
      await pool`INSERT INTO proxies (id, name, protocol, host, port, active) VALUES (${id}, ${String(v.name ?? id)}, ${String(v.protocol ?? "http")}, ${String(v.host ?? "127.0.0.1")}, ${Number(v.port ?? 8080)}, true)`;
      onMutation();
      return { ok: true, status: 201, data: { id } };
    },
    async update(id: string, body: unknown) {
      const v = (body ?? {}) as Record<string, unknown>;
      if (v.active !== undefined) await pool`UPDATE proxies SET active = ${v.active === true}, updated_at = now() WHERE id = ${id}`;
      if (v.host) await pool`UPDATE proxies SET host = ${String(v.host)}, updated_at = now() WHERE id = ${id}`;
      onMutation();
      return { ok: true, status: 200, data: {} };
    },
    async remove(id: string) { await pool`DELETE FROM proxies WHERE id = ${id}`; onMutation(); return { ok: true, status: 200, data: {} }; },
    async health() { const rows = (await pool`SELECT proxy_id, status FROM proxy_health`) as unknown as unknown; return rows; },
    async test(body: unknown) {
      const v = (body ?? {}) as Record<string, unknown>;
      const host = typeof v.host === "string" ? v.host.trim() : "";
      const port = Number(v.port);
      if (!host || !Number.isFinite(port) || port <= 0 || port > 65535) return { ok: false, status: 400, message: "host and valid port required", data: { ok: false, error: "host and valid port required" } };
      const result = await testConnection(String(v.protocol ?? ""), host, port);
      if (result.ok) {
        await pool`UPDATE proxies SET active = true, last_test_at = now(), last_test_success_at = now(), last_test_success_latency_ms = ${result.latencyMs}, last_test_error = NULL WHERE host = ${host} AND port = ${port}`;
        onMutation();
        return { ok: true, status: 200, data: { ok: true, latencyMs: result.latencyMs, ...(result.egressIp === undefined ? {} : { egressIp: result.egressIp }) } };
      }
      await pool`UPDATE proxies SET active = false, last_test_at = now(), last_test_error_at = now(), last_test_error = ${result.error ?? "proxy unreachable"} WHERE host = ${host} AND port = ${port}`;
      onMutation();
      return { ok: false, status: 502, message: result.error ?? "proxy unreachable", data: { ok: false, latencyMs: result.latencyMs, error: result.error ?? "proxy unreachable" } };
    },
    async testOne(id: string) {
      const rows = (await pool`SELECT protocol, host, port FROM proxies WHERE id = ${id}`) as unknown as Array<Record<string, unknown>>;
      const row = rows[0];
      if (!row) return { ok: false, status: 404, code: "model_not_found" as const, message: `proxy ${id} not found` };
      const host = String(row.host ?? "");
      const port = Number(row.port);
      const result = await testConnection(String(row.protocol ?? ""), host, port);
      if (result.ok) {
        await pool`UPDATE proxies SET active = true, last_test_at = now(), last_test_success_at = now(), last_test_success_latency_ms = ${result.latencyMs}, last_test_error = NULL WHERE id = ${id}`;
        onMutation();
        await pool`UPDATE wireguard_tunnels SET runtime_status = 'running', egress_ip = ${result.egressIp ?? null}, last_health_check_at = now(), last_error = NULL, updated_at = now() WHERE proxy_id = ${id}`;
      } else {
        await pool`UPDATE proxies SET active = false, last_test_at = now(), last_test_error_at = now(), last_test_error = ${result.error ?? "proxy unreachable"} WHERE id = ${id}`;
        onMutation();
        await pool`UPDATE wireguard_tunnels SET runtime_status = 'unhealthy', last_health_check_at = now(), last_error = ${result.error ?? "proxy unreachable"}, updated_at = now() WHERE proxy_id = ${id}`;
      }
      if (result.ok) return { ok: true, status: 200, data: { ok: true, latencyMs: result.latencyMs, proxyId: id, ...(result.egressIp === undefined ? {} : { egressIp: result.egressIp }) } };
      return { ok: false, status: 502, message: result.error ?? "proxy unreachable", data: { ok: false, latencyMs: result.latencyMs, proxyId: id, error: result.error ?? "proxy unreachable" } };
    },
  };
}
