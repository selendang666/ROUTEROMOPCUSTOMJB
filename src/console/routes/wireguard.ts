import type { Elysia } from "elysia";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { errorResponse, jsonResponse } from "../../api/errors.js";
import { toResponse } from "../../api/guard.js";
import type { ConsoleDependencies } from "../api.js";
import {
  wireguardProcesses,
  getWireguardPoolEnabled,
  setWireguardPoolEnabled,
  withWireguardImportLock,
  wireguardConfigWithSocks,
  validateWireguardConfig,
  isAllowedWireproxyBin,
} from "../wireguard-helpers.js";

export function registerWireguardRoutes(app: Elysia, deps: ConsoleDependencies): void {
  (app as unknown as { get: (path: string, handler: (ctx: unknown) => unknown) => unknown }).get(
    "/console/api/wireguard/status",
    async () => {
      if (deps.pool) {
        const settings = await deps.pool`SELECT enabled FROM wireguard_pool_settings WHERE id = true`;
        const rows = (await deps.pool`SELECT proxy_id, socks_port, enabled, runtime_status, egress_ip, last_error FROM wireguard_tunnels ORDER BY name, id`) as unknown as Array<{
          proxy_id: string | null;
          socks_port: number;
          enabled: boolean;
          runtime_status: string;
          egress_ip: string | null;
          last_error: string | null;
        }>;
        setWireguardPoolEnabled(settings[0]?.enabled === true);
        for (const row of rows) {
          if (row.proxy_id !== null && !wireguardProcesses.has(row.proxy_id) && row.runtime_status === "running") {
            await deps.pool`UPDATE wireguard_tunnels SET enabled = false, runtime_status = 'stopped', last_error = 'process not running', updated_at = now() WHERE proxy_id = ${row.proxy_id}`;
            await deps.services.proxies.update(row.proxy_id, { active: false });
          }
        }
        const tunnels = rows.map((row) => ({
          proxyId: row.proxy_id,
          port: row.socks_port,
          active: row.enabled === true && wireguardProcesses.has(String(row.proxy_id)),
          runtimeStatus: wireguardProcesses.has(String(row.proxy_id))
            ? "running"
            : row.runtime_status === "running"
              ? "stopped"
              : row.runtime_status,
          egressIp: row.egress_ip ?? null,
          error: wireguardProcesses.has(String(row.proxy_id))
            ? (row.last_error ?? null)
            : row.runtime_status === "running"
              ? "process not running"
              : (row.last_error ?? null),
        }));
        return jsonResponse({
          enabled: getWireguardPoolEnabled(),
          running: tunnels.filter((tunnel) => tunnel.runtimeStatus === "running").length,
          total: tunnels.length,
          tunnels,
        });
      }
      const proxies = (await deps.services.proxies.list()) as Array<{ id: string; host: string; port: number; active: boolean }>;
      const tunnels = proxies
        .filter((proxy) => proxy.host === "127.0.0.1" && proxy.port >= 11080 && proxy.port < 12000)
        .map((proxy) => ({
          proxyId: proxy.id,
          port: proxy.port,
          active: proxy.active,
          runtimeStatus: wireguardProcesses.has(proxy.id) ? "running" : "stopped",
        }));
      const running = tunnels.filter((tunnel: (typeof tunnels)[number]) => tunnel.runtimeStatus === "running").length;
      return jsonResponse({ enabled: getWireguardPoolEnabled(), running, total: tunnels.length, tunnels });
    },
  );
  (app as unknown as { post: (path: string, handler: (ctx: unknown) => unknown) => unknown }).post(
    "/console/api/wireguard/validate",
    async ({ body }: any /* Elysia ctx */) => {
      const content = body !== null && typeof body === "object" && typeof body.content === "string" ? body.content : "";
      if (
        !content.includes("[Interface]") ||
        !content.includes("[Peer]") ||
        !content.includes("PrivateKey") ||
        !content.includes("PublicKey")
      )
        return errorResponse(400, "invalid_request", "WireGuard INI must contain valid Interface and Peer sections.");
      const wireproxyBin = Bun.env.WIREPROXY_BIN?.trim() || "./bin/wireproxy.exe";
      const path = join(tmpdir(), `ohmyomop-router-wireguard-${crypto.randomUUID()}.conf`);
      await Bun.write(path, content);
      try {
        const error = await validateWireguardConfig(wireproxyBin, path);
        return error === null ? jsonResponse({ ok: true, validated: true }) : errorResponse(400, "invalid_request", error);
      } finally {
        await Bun.file(path).delete();
      }
    },
  );
  (app as unknown as { post: (path: string, handler: (ctx: unknown) => unknown) => unknown }).post(
    "/console/api/wireguard/warp/create",
    async () => {
      if (Bun.env.OHMYOMOP_ROUTER_ENABLE_WARP !== "1") return errorResponse(404, "internal_error", "WARP generation not enabled");
      const warpProcess = Bun.spawn(["bun", "run", "scripts/warp-generate.ts"], { stdout: "pipe", stderr: "pipe" });
      const exitCode = await warpProcess.exited;
      if (exitCode !== 0)
        return errorResponse(502, "provider_unavailable", (await new Response(warpProcess.stderr).text()).trim() || "WARP config generation failed.");
      return jsonResponse({ ok: true, content: await new Response(warpProcess.stdout).text() });
    },
  );
  (app as unknown as { post: (path: string, handler: (ctx: unknown) => unknown) => unknown }).post(
    "/console/api/wireguard/toggle",
    async ({ body }: any /* Elysia ctx */) => {
      const enabled = body !== null && typeof body === "object" && body.enabled === true;
      setWireguardPoolEnabled(enabled);
      if (deps.pool) await deps.pool`UPDATE wireguard_pool_settings SET enabled = ${enabled}, updated_at = now() WHERE id = true`;
      if (!enabled) {
        for (const [proxyId, process] of wireguardProcesses) {
          try {
            process.kill();
          } catch {}
          wireguardProcesses.delete(proxyId);
        }
        if (deps.pool) {
          const tunnelProxies = (await deps.pool`SELECT proxy_id FROM wireguard_tunnels WHERE proxy_id IS NOT NULL`) as unknown as Array<{
            proxy_id: string;
          }>;
          for (const row of tunnelProxies) {
            if (row.proxy_id) await deps.services.proxies.update(row.proxy_id, { active: false });
          }
          await deps.pool`UPDATE wireguard_tunnels SET enabled = false, runtime_status = 'stopped', last_error = 'Wireguard2Socks offline', updated_at = now()`;
        }
      } else if (deps.pool) {
        await deps.pool`UPDATE wireguard_tunnels SET enabled = true, updated_at = now() WHERE enabled = false`;
        const wireproxyBin = Bun.env.WIREPROXY_BIN?.trim() || "./bin/wireproxy.exe";
        const tunnels = (await deps.pool`SELECT proxy_id, config_path, socks_port FROM wireguard_tunnels WHERE enabled = true`) as unknown as Array<{
          proxy_id: string | null;
          config_path: string;
          socks_port: number;
        }>;
        for (const tunnel of tunnels) {
          if (!tunnel.proxy_id || wireguardProcesses.has(tunnel.proxy_id)) continue;
          try {
            const file = Bun.file(tunnel.config_path);
            if (!(await file.exists())) continue;
            const proc = Bun.spawn([wireproxyBin, "-c", tunnel.config_path], { stdout: "ignore", stderr: "pipe" });
            wireguardProcesses.set(tunnel.proxy_id, proc);
            await deps.services.proxies.update(tunnel.proxy_id, { active: true });
            await deps.pool`UPDATE wireguard_tunnels SET runtime_status = 'running', last_error = NULL, updated_at = now() WHERE proxy_id = ${tunnel.proxy_id}`;
            void proc.exited.then(async () => {
              wireguardProcesses.delete(tunnel.proxy_id!);
              await deps.services.proxies.update(tunnel.proxy_id!, { active: false });
              if (deps.pool)
                await deps.pool`UPDATE wireguard_tunnels SET enabled = false, runtime_status = 'failed', last_error = 'wireproxy process exited', updated_at = now() WHERE proxy_id = ${tunnel.proxy_id}`;
            });
          } catch {}
        }
      }
      const running = wireguardProcesses.size;
      const totalRow = deps.pool
        ? (((await deps.pool`SELECT COUNT(*)::int as total FROM wireguard_tunnels`) as unknown as Array<{ total: number }>)[0]?.total ?? 0)
        : 0;
      return jsonResponse({ enabled: getWireguardPoolEnabled(), running, total: totalRow });
    },
  );
  (app as unknown as { post: (path: string, handler: (ctx: { body: unknown }) => Promise<Response>) => unknown }).post(
    "/console/api/wireguard/import",
    async ({ body }) =>
      withWireguardImportLock(async () => {
        if (!getWireguardPoolEnabled()) return errorResponse(409, "invalid_request", "WireGuard pool is disabled.");
        const content =
          body !== null && typeof body === "object" && "content" in body && typeof (body as Record<string, unknown>).content === "string"
            ? ((body as Record<string, unknown>).content as string)
            : "";
        if (!content.includes("[Interface]") || !content.includes("[Peer]")) {
          return errorResponse(400, "invalid_request", "WireGuard INI must contain [Interface] and [Peer]");
        }
        if (!content.includes("PrivateKey") || !content.includes("PublicKey")) {
          return errorResponse(400, "invalid_request", "WireGuard INI missing PrivateKey or PublicKey");
        }
        const nameCandidate =
          body !== null && typeof body === "object" && "name" in body && typeof (body as Record<string, unknown>).name === "string"
            ? ((body as Record<string, unknown>).name as string).trim()
            : "";
        const name = nameCandidate.length > 0 ? nameCandidate.slice(0, 64) : `wg-${Date.now().toString(36)}`;
        const wireproxyBin = Bun.env.WIREPROXY_BIN?.trim() || "./bin/wireproxy.exe";
        const portCandidate =
          body !== null && typeof body === "object" && "port" in body ? Number((body as Record<string, unknown>).port) : 0;
        const proxies = (await deps.services.proxies.list()) as Array<{ host?: string; port?: number }>;
        const usedPorts = new Set(proxies.filter((proxy) => proxy.host === "127.0.0.1").map((proxy) => proxy.port));
        if (deps.pool) {
          await deps.pool`DELETE FROM wireguard_tunnels WHERE proxy_id IS NULL`;
          const tunnelRows = await deps.pool`SELECT socks_port FROM wireguard_tunnels`;
          for (const row of tunnelRows) usedPorts.add(row.socks_port);
        }
        const startPort = Number(Bun.env.WIREGUARD_START_PORT ?? "11080");
        let targetPort =
          Number.isFinite(portCandidate) && portCandidate > 0 && portCandidate < 65535 ? Math.floor(portCandidate) : startPort;
        while (usedPorts.has(targetPort) && targetPort < 65535) targetPort += 1;
        if (targetPort >= 65535) return errorResponse(409, "invalid_request", "No local WireGuard SOCKS5 port is available.");
        const configDir = Bun.env.WIREGUARD_CONFIG_DIR?.trim() || "./data/wireguard";
        await mkdir(configDir, { recursive: true });
        const safeName = name.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || `wg-${Date.now().toString(36)}`;
        const configPath = join(configDir, `${safeName}-${targetPort}.conf`);
        const config = wireguardConfigWithSocks(content, targetPort);
        await Bun.write(configPath, config);
        try {
          await Bun.spawn(["chmod", "0600", configPath]).exited;
        } catch {}
        if (!isAllowedWireproxyBin(wireproxyBin)) return errorResponse(400, "invalid_request", "WireGuard binary not allowlisted");
        const validationError = await validateWireguardConfig(wireproxyBin, configPath);
        if (validationError !== null) {
          await Bun.file(configPath).delete();
          return errorResponse(400, "invalid_request", validationError);
        }
        const process = Bun.spawn([wireproxyBin, "-c", configPath], { stdout: "ignore", stderr: "pipe" });
        const proxy = await deps.services.proxies.create({ name, protocol: "socks5", host: "127.0.0.1", port: targetPort });
        if (!proxy.ok) {
          process.kill();
          await Bun.file(configPath).delete();
          return errorResponse(proxy.status, "invalid_request", proxy.message ?? "WireGuard proxy registration failed.");
        }
        const proxyId =
          typeof proxy.data === "object" && proxy.data !== null && "id" in proxy.data ? String((proxy.data as Record<string, unknown>).id) : "";
        wireguardProcesses.set(proxyId, process);
        if (deps.pool) {
          try {
            await deps.pool`
            INSERT INTO wireguard_tunnels (id, name, config_path, proxy_id, enabled, runtime_status, process_id, socks_host, socks_port, last_health_check_at)
            VALUES (${crypto.randomUUID()}, ${name}, ${configPath}, ${proxyId}, true, 'starting', ${process.pid ?? null}, '127.0.0.1', ${targetPort}, now())
          `;
          } catch (error) {
            wireguardProcesses.delete(proxyId);
            process.kill();
            await deps.services.proxies.remove(proxyId);
            await Bun.file(configPath).delete();
            const message = error instanceof Error ? error.message : "WireGuard tunnel persistence failed.";
            return errorResponse(500, "invalid_request", message);
          }
        }
        void process.exited.then(async () => {
          wireguardProcesses.delete(proxyId);
          await deps.services.proxies.update(proxyId, { active: false });
          if (deps.pool)
            await deps.pool`UPDATE wireguard_tunnels SET enabled = false, runtime_status = 'failed', last_error = 'wireproxy process exited', updated_at = now() WHERE proxy_id = ${proxyId}`;
        });
        return jsonResponse({ ok: true, name, proxyId, targetPort, configPath, validated: true, registered: true });
      }),
  );
}
