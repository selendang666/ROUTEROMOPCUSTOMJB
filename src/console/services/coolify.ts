/**
 * Coolify monitoring service — console business logic over stored instances.
 *
 * Single owner of: connection CRUD, token-gated probing, and read-through
 * aggregation of projects/applications/services/servers/deployments from
 * the Coolify v4 REST API. Never returns decrypted tokens to callers.
 */

import type { ConsoleServiceResult } from "../../api/guard.js";
import type { PostgresPool } from "../../persistence/pool.js";
import {
  getApplication,
  getProject,
  listApplicationDeployments,
  listApplications,
  listDeployments,
  listProjects,
  listServers,
  listServices,
  probeConnection,
  validateConnectionInput,
} from "../coolify/client.js";
import { createCoolifyStore, type CoolifyStore } from "../coolify/store.js";
import type { CoolifyConnection, CoolifyOverview } from "../coolify/types.js";

function ok(data: unknown): ConsoleServiceResult {
  return { ok: true as const, status: 200 as const, data };
}


interface Credentials {
  readonly connection: CoolifyConnection;
  readonly apiToken: string;
}

function fail(status: number, message: string): ConsoleServiceResult {
  return { ok: false as const, status: status as 400, message };
}

/**
 * Create the Coolify monitoring service.
 *
 * @param pool - Postgres connection pool (owns `coolify_servers`).
 * @returns Service consumed by the console router.
 */
export function createCoolifyService(pool: PostgresPool) {
  const store: CoolifyStore = createCoolifyStore(pool);

  return {
    /**
     * List configured instances (tokens excluded).
     *
     * @returns Service result with `CoolifyConnection[]`.
     */
    async list(): Promise<ConsoleServiceResult> {
      try {
        return ok({ connections: await store.list() });
      } catch (err) {
        return fail(500, err instanceof Error ? err.message : "Failed to list Coolify connections");
      }
    },

    /**
     * Register a new instance and verify it before persisting.
     *
     * The probe runs first so a typo'd URL/token never lands in the DB.
     *
     * @param body - Dashboard payload `{ name, baseUrl, apiToken, enabled? }`.
     * @returns Created connection plus probe outcome.
     */
    async create(body: unknown): Promise<ConsoleServiceResult> {
      let input: { readonly name: string; readonly baseUrl: string; readonly apiToken: string };
      try {
        const raw = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
        input = validateConnectionInput({ name: raw.name, baseUrl: raw.baseUrl, apiToken: raw.apiToken });
      } catch (err) {
        return fail(400, err instanceof Error ? err.message : "Invalid Coolify connection input");
      }
      const raw = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
      const enabled = raw.enabled === undefined ? true : raw.enabled === true;
      const probe = await probeConnection(input.baseUrl, input.apiToken);
      if (!probe.ok) return fail(502, `Coolify unreachable: ${probe.error ?? "probe failed"}`);
      try {
        const connection = await store.create({ ...input, enabled });
        return ok({ connection, probe });
      } catch (err) {
        return fail(500, err instanceof Error ? err.message : "Failed to save Coolify connection");
      }
    },

    /**
     * Update an instance (token optional — empty keeps the stored one).
     *
     * @param id - Connection id.
     * @param body - Partial `{ name?, baseUrl?, apiToken?, enabled? }`.
     * @returns Updated connection or 404.
     */
    async update(id: string, body: unknown): Promise<ConsoleServiceResult> {
      const raw = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
      let patch: { readonly name?: string; readonly baseUrl?: string; readonly apiToken?: string; readonly enabled?: boolean } = {};
      if (raw.name !== undefined) {
        if (typeof raw.name !== "string" || raw.name.trim().length === 0) return fail(400, "name must be a non-empty string");
        patch = { ...patch, name: raw.name.trim() };
      }
      if (raw.baseUrl !== undefined) {
        if (typeof raw.baseUrl !== "string" || raw.baseUrl.trim().length === 0) return fail(400, "baseUrl must be a non-empty string");
        try {
          const { normalizeBaseUrl } = await import("../coolify/client.js");
          patch = { ...patch, baseUrl: normalizeBaseUrl(raw.baseUrl) };
        } catch (err) {
          return fail(400, err instanceof Error ? err.message : "Invalid baseUrl");
        }
      }
      if (raw.apiToken !== undefined) {
        if (typeof raw.apiToken !== "string") return fail(400, "apiToken must be a string");
        const trimmed = raw.apiToken.trim();
        if (trimmed.length > 0) patch = { ...patch, apiToken: trimmed };
      }
      if (raw.enabled !== undefined) patch = { ...patch, enabled: raw.enabled === true };
      try {
        const updated = await store.update(id, patch);
        if (updated === null) return fail(404, "Coolify connection not found");
        return ok({ connection: updated });
      } catch (err) {
        return fail(500, err instanceof Error ? err.message : "Failed to update Coolify connection");
      }
    },

    /**
     * Delete an instance.
     *
     * @param id - Connection id.
     * @returns `{ removed: true }` or 404.
     */
    async remove(id: string): Promise<ConsoleServiceResult> {
      try {
        const removed = await store.remove(id);
        if (!removed) return fail(404, "Coolify connection not found");
        return ok({ removed: true });
      } catch (err) {
        return fail(500, err instanceof Error ? err.message : "Failed to delete Coolify connection");
      }
    },

    /**
     * Probe reachability + token validity without persisting.
     *
     * Used by the dashboard "test" button for both saved instances
     * (`{ id }`) and ad-hoc forms (`{ baseUrl, apiToken }`).
     *
     * @param body - `{ id? }` or `{ baseUrl, apiToken }`.
     * @returns Probe result.
     */
    async test(body: unknown): Promise<ConsoleServiceResult> {
      const raw = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
      try {
        if (typeof raw.id === "string" && raw.id.length > 0) {
          const found = await store.getWithToken(raw.id);
          if (found === null) return fail(404, "Coolify connection not found");
          if (!found.connection.enabled) return fail(400, "Connection is disabled");
          return ok({ probe: await probeConnection(found.connection.baseUrl, found.apiToken) });
        }
        const input = validateConnectionInput({ name: "probe", baseUrl: raw.baseUrl, apiToken: raw.apiToken });
        return ok({ probe: await probeConnection(input.baseUrl, input.apiToken) });
      } catch (err) {
        return fail(400, err instanceof Error ? err.message : "Invalid probe input");
      }
    },

    /**
     * Aggregated snapshot for the dashboard header (reachability + counts).
     *
     * List calls fail open per-collection so one denied endpoint (token
     * without `root`) still shows the rest instead of a blank page.
     *
     * @param id - Connection id.
     * @returns Overview snapshot.
     */
    async overview(id: string): Promise<ConsoleServiceResult> {
      let found: Credentials | null;
      try {
        found = await store.getWithToken(id);
      } catch (err) {
        return fail(500, err instanceof Error ? err.message : "Failed to load Coolify connection");
      }
      if (found === null) return fail(404, "Coolify connection not found");
      const { connection, apiToken } = found;
      const probe = await probeConnection(connection.baseUrl, apiToken);
      const overview: CoolifyOverview = {
        connection,
        reachable: probe.ok,
        version: probe.version ?? null,
        team: probe.team ?? null,
        latencyMs: probe.latencyMs,
        error: probe.ok ? null : (probe.error ?? "unreachable"),
      };
      if (!probe.ok) return ok({ overview });
      const [projects, applications, services, servers, deployments] = await Promise.all([
        listProjects(connection.baseUrl, apiToken).catch(() => null),
        listApplications(connection.baseUrl, apiToken).catch(() => null),
        listServices(connection.baseUrl, apiToken).catch(() => null),
        listServers(connection.baseUrl, apiToken).catch(() => null),
        listDeployments(connection.baseUrl, apiToken).catch(() => null),
      ]);
      return ok({
        overview: {
          ...overview,
          counts: {
            projects: projects?.length ?? 0,
            applications: applications?.length ?? 0,
            services: services?.length ?? 0,
            servers: servers?.length ?? 0,
            runningDeployments: deployments?.length ?? 0,
          },
        },
      });
    },

    /**
     * List projects deployed on the instance.
     *
     * @param id - Connection id.
     * @returns `{ projects }`.
     */
    async projects(id: string): Promise<ConsoleServiceResult> {
      let found: Credentials | null;
      try {
        found = await store.getWithToken(id);
      } catch (err) {
        return fail(500, err instanceof Error ? err.message : "Failed to load Coolify connection");
      }
      if (found === null) return fail(404, "Coolify connection not found");
      try {
        return ok({ projects: await listProjects(found.connection.baseUrl, found.apiToken) });
      } catch (err) {
        return fail(502, err instanceof Error ? err.message : "Failed to list Coolify projects");
      }
    },

    /**
     * Full project detail — environments with their applications/services.
     *
     * This is what the dashboard opens when a deployed project is clicked.
     *
     * @param id - Connection id.
     * @param uuid - Project UUID.
     * @returns `{ project }`.
     */
    async projectDetail(id: string, uuid: string): Promise<ConsoleServiceResult> {
      let found: Credentials | null;
      try {
        found = await store.getWithToken(id);
      } catch (err) {
        return fail(500, err instanceof Error ? err.message : "Failed to load Coolify connection");
      }
      if (found === null) return fail(404, "Coolify connection not found");
      try {
        return ok({ project: await getProject(found.connection.baseUrl, found.apiToken, uuid) });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to load project";
        return fail(/not found \(404\)/i.test(message) ? 404 : 502, message);
      }
    },

    /**
     * List applications deployed on the instance.
     *
     * @param id - Connection id.
     * @returns `{ applications }`.
     */
    async applications(id: string): Promise<ConsoleServiceResult> {
      let found: Credentials | null;
      try {
        found = await store.getWithToken(id);
      } catch (err) {
        return fail(500, err instanceof Error ? err.message : "Failed to load Coolify connection");
      }
      if (found === null) return fail(404, "Coolify connection not found");
      try {
        return ok({ applications: await listApplications(found.connection.baseUrl, found.apiToken) });
      } catch (err) {
        return fail(502, err instanceof Error ? err.message : "Failed to list Coolify applications");
      }
    },

    /**
     * Application detail with its recent deployments.
     *
     * @param id - Connection id.
     * @param uuid - Application UUID.
     * @returns `{ application, deployments }`.
     */
    async applicationDetail(id: string, uuid: string): Promise<ConsoleServiceResult> {
      let found: Credentials | null;
      try {
        found = await store.getWithToken(id);
      } catch (err) {
        return fail(500, err instanceof Error ? err.message : "Failed to load Coolify connection");
      }
      if (found === null) return fail(404, "Coolify connection not found");
      try {
        const [application, deployments] = await Promise.all([
          getApplication(found.connection.baseUrl, found.apiToken, uuid),
          listApplicationDeployments(found.connection.baseUrl, found.apiToken, uuid).catch(() => []),
        ]);
        return ok({ application, deployments });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to load application";
        return fail(/not found \(404\)/i.test(message) ? 404 : 502, message);
      }
    },

    /**
     * List services on the instance.
     *
     * @param id - Connection id.
     * @returns `{ services }`.
     */
    async services(id: string): Promise<ConsoleServiceResult> {
      let found: Credentials | null;
      try {
        found = await store.getWithToken(id);
      } catch (err) {
        return fail(500, err instanceof Error ? err.message : "Failed to load Coolify connection");
      }
      if (found === null) return fail(404, "Coolify connection not found");
      try {
        return ok({ services: await listServices(found.connection.baseUrl, found.apiToken) });
      } catch (err) {
        return fail(502, err instanceof Error ? err.message : "Failed to list Coolify services");
      }
    },

    /**
     * List servers on the instance.
     *
     * @param id - Connection id.
     * @returns `{ servers }`.
     */
    async servers(id: string): Promise<ConsoleServiceResult> {
      let found: Credentials | null;
      try {
        found = await store.getWithToken(id);
      } catch (err) {
        return fail(500, err instanceof Error ? err.message : "Failed to load Coolify connection");
      }
      if (found === null) return fail(404, "Coolify connection not found");
      try {
        return ok({ servers: await listServers(found.connection.baseUrl, found.apiToken) });
      } catch (err) {
        return fail(502, err instanceof Error ? err.message : "Failed to list Coolify servers");
      }
    },

    /**
     * List currently running deployments.
     *
     * @param id - Connection id.
     * @returns `{ deployments }`.
     */
    async deployments(id: string): Promise<ConsoleServiceResult> {
      let found: Credentials | null;
      try {
        found = await store.getWithToken(id);
      } catch (err) {
        return fail(500, err instanceof Error ? err.message : "Failed to load Coolify connection");
      }
      if (found === null) return fail(404, "Coolify connection not found");
      try {
        return ok({ deployments: await listDeployments(found.connection.baseUrl, found.apiToken) });
      } catch (err) {
        return fail(502, err instanceof Error ? err.message : "Failed to list Coolify deployments");
      }
    },
  };
}

/** Service shape registered on `ConsolePorts.coolify`. */
export type CoolifyService = ReturnType<typeof createCoolifyService>;
