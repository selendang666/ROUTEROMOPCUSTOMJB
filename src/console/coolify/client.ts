/**
 * Coolify v4 REST client — pure helpers plus a thin fetch wrapper.
 *
 * Base URL rule: `{instance}/api/v1/*`, Bearer token auth. Health probes
 * (`/api/health`, `/api/v1/health`) need no token; everything else does.
 * Reference: https://coolify.io/docs/api/overview
 */

import type {
  CoolifyApplication,
  CoolifyDeployment,
  CoolifyProbeResult,
  CoolifyProject,
  CoolifyProjectDetail,
  CoolifyServer,
  CoolifyService,
} from "./types.js";

/** Timeout for a single Coolify API round-trip. */
export const COOLIFY_REQUEST_TIMEOUT_MS = 15_000;

/** Hard cap on a Coolify response body (10 MiB). */
export const COOLIFY_MAX_RESPONSE_BYTES = 10_485_760;

/**
 * Normalize a user-supplied instance URL to its origin root.
 *
 * Accepts `https://coolify.example.com`, the same with a trailing slash,
 * or a pasted API URL (`…/api/v1`, `…/api/v1/projects`); always returns the
 * origin root so callers can append `/api/v1/*` exactly once.
 *
 * @param raw - Raw URL from the dashboard input.
 * @returns Origin root such as `https://coolify.example.com`.
 */
export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (trimmed.length === 0) throw new Error("Coolify URL is required");
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("Coolify URL must be a valid http(s) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Coolify URL must start with http:// or https://");
  }
  // Strip a pasted API suffix back to the instance root.
  const apiIndex = url.pathname.indexOf("/api/");
  const rootPath = apiIndex >= 0 ? url.pathname.slice(0, apiIndex) : url.pathname;
  const cleanPath = rootPath === "/" ? "" : rootPath.replace(/\/+$/, "");
  return `${url.protocol}//${url.host}${cleanPath}`;
}

/**
 * Validate a connection input before it touches the network or the database.
 *
 * @param input - Raw dashboard payload.
 * @returns Normalized `{ name, baseUrl, apiToken }` or throws.
 */
export function validateConnectionInput(input: {
  readonly name?: unknown;
  readonly baseUrl?: unknown;
  readonly apiToken?: unknown;
}): { readonly name: string; readonly baseUrl: string; readonly apiToken: string } {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const baseUrlRaw = typeof input.baseUrl === "string" ? input.baseUrl.trim() : "";
  const apiToken = typeof input.apiToken === "string" ? input.apiToken.trim() : "";
  if (name.length === 0) throw new Error("name is required");
  if (name.length > 120) throw new Error("name must be at most 120 characters");
  if (baseUrlRaw.length === 0) throw new Error("baseUrl is required");
  if (apiToken.length === 0) throw new Error("apiToken is required");
  return { name, baseUrl: normalizeBaseUrl(baseUrlRaw), apiToken };
}

export interface CoolifyRequestOptions {
  /** Override timeout per call (ms). */
  readonly timeoutMs?: number;
  /** Extra fetch init (method/body for future write calls). */
  readonly init?: RequestInit;
}

/**
 * Single authenticated GET against a Coolify instance.
 *
 * @param baseUrl - Normalized instance root (see {@link normalizeBaseUrl}).
 * @param apiToken - Full API token value (`id|secret` intact).
 * @param path - API path starting with `/api/v1/`.
 * @param options - Timeout/extra fetch options.
 * @returns Parsed JSON payload.
 */
export async function coolifyRequest<T>(
  baseUrl: string,
  apiToken: string,
  path: string,
  options?: CoolifyRequestOptions,
): Promise<T> {
  const root = normalizeBaseUrl(baseUrl);
  if (!path.startsWith("/api/v1/") && path !== "/api/v1/version") {
    throw new Error("Coolify API path must start with /api/v1/");
  }
  const timeoutMs = options?.timeoutMs ?? COOLIFY_REQUEST_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Coolify request timed out")), timeoutMs);
  try {
    const res = await fetch(`${root}${path}`, {
      ...(options?.init ?? {}),
      method: options?.init?.method ?? "GET",
      headers: {
        "authorization": `Bearer ${apiToken}`,
        "accept": "application/json",
        "content-type": "application/json",
        ...(options?.init?.headers ?? {}),
      },
      signal: controller.signal,
    });
    const buf = await res.arrayBuffer();
    if (buf.byteLength > COOLIFY_MAX_RESPONSE_BYTES) {
      throw new Error(`Coolify response too large (${buf.byteLength} bytes)`);
    }
    const text = buf.byteLength === 0 ? "" : new TextDecoder().decode(buf);
    let parsed: unknown = null;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    if (res.status === 401) throw new Error("Invalid Coolify token (401) — check Keys & Tokens → API tokens");
    if (res.status === 403) throw new Error("Forbidden (403) — token lacks permission or API access is disabled");
    if (res.status === 404) throw new Error(`Coolify resource not found (404): ${path}`);
    if (!res.ok) {
      const detail =
        parsed !== null && typeof parsed === "object" && "message" in (parsed as Record<string, unknown>)
          ? String((parsed as Record<string, unknown>).message)
          : `HTTP ${res.status}`;
      throw new Error(`Coolify request failed: ${detail}`);
    }
    return parsed as T;
  } catch (err) {
    if (err instanceof Error) {
      if (err.name === "AbortError" || /timed out/i.test(err.message)) {
        throw new Error(`Coolify at ${root} is unreachable (timeout after ${timeoutMs}ms)`);
      }
      // Undici fetch wraps DNS/TLS failures in TypeError.
      if (err instanceof TypeError) throw new Error(`Coolify at ${root} is unreachable: ${err.message}`);
      throw err;
    }
    throw new Error(`Coolify at ${root} is unreachable`);
  } finally {
    clearTimeout(timer);
  }
}

function asArray<T>(value: unknown): readonly T[] {
  return Array.isArray(value) ? (value as readonly T[]) : [];
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function rec(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Probe instance reachability + token validity via `/api/v1/teams/current`.
 *
 * @param baseUrl - Normalized instance root.
 * @param apiToken - Full API token value.
 * @returns Probe result (never throws; failures surface as `{ ok: false }`).
 */
export async function probeConnection(baseUrl: string, apiToken: string): Promise<CoolifyProbeResult> {
  const started = Date.now();
  try {
    const team = await coolifyRequest<Record<string, unknown>>(baseUrl, apiToken, "/api/v1/teams/current");
    let version: string | null = null;
    try {
      const v = await coolifyRequest<unknown>(baseUrl, apiToken, "/api/v1/version", { timeoutMs: 8000 });
      version = typeof v === "string" ? v : str(rec(v).version) ?? str(rec(v).data) ?? null;
    } catch {
      version = null;
    }
    const teamRec = rec(team);
    const teamName = str(teamRec.name) ?? str(rec(teamRec.currentTeam).name) ?? str(teamRec.email) ?? null;
    return { ok: true, version, team: teamName, latencyMs: Date.now() - started };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      error: err instanceof Error ? err.message : "probe failed",
    };
  }
}

/**
 * List all projects on the instance.
 *
 * @param baseUrl - Normalized instance root.
 * @param apiToken - Full API token value.
 * @returns Normalized project rows.
 */
export async function listProjects(baseUrl: string, apiToken: string): Promise<readonly CoolifyProject[]> {
  const raw = await coolifyRequest<unknown>(baseUrl, apiToken, "/api/v1/projects");
  return asArray<Record<string, unknown>>(raw).map((row) => ({
    uuid: str(row.uuid) ?? str(row.id) ?? "",
    name: str(row.name) ?? "(unnamed)",
    description: typeof row.description === "string" ? row.description : null,
    raw: row,
  })).filter((p) => p.uuid.length > 0);
}

/**
 * Fetch one project with its environments/applications/services.
 *
 * The API returns environments each carrying their applications/services, so
 * this flattens them onto the detail payload for the dashboard.
 *
 * @param baseUrl - Normalized instance root.
 * @param apiToken - Full API token value.
 * @param uuid - Project UUID.
 * @returns Project detail with flattened applications/services.
 */
export async function getProject(baseUrl: string, apiToken: string, uuid: string): Promise<CoolifyProjectDetail> {
  const raw = await coolifyRequest<unknown>(baseUrl, apiToken, `/api/v1/projects/${encodeURIComponent(uuid)}`);
  const row = rec(raw);
  const environments = asArray<Record<string, unknown>>(row.environments).map((env) => ({
    id: typeof env.id === "number" ? env.id : undefined,
    name: str(env.name) ?? "(unnamed)",
    uuid: str(env.uuid) ?? undefined,
    raw: env,
  }));
  const applications: CoolifyApplication[] = [];
  const services: CoolifyService[] = [];
  const databases: unknown[] = [];
  // Some payloads nest resources under environments; others return them flat.
  const nestedSources = environments.length > 0 ? environments.map((e) => rec(e.raw)) : [row];
  for (const source of nestedSources) {
    for (const app of asArray<Record<string, unknown>>(source.applications)) {
      applications.push(normalizeApplication(app, str(row.uuid) ?? null, str(source.name)));
    }
    for (const svc of asArray<Record<string, unknown>>(source.services)) {
      services.push(normalizeService(svc, str(row.uuid) ?? null, str(source.name)));
    }
    const dbs = source.databases ?? source.postgresql ?? source.mysql ?? source.mongodb ?? source.redis;
    for (const db of asArray<unknown>(dbs)) databases.push(db);
  }
  for (const app of asArray<Record<string, unknown>>(row.applications)) {
    applications.push(normalizeApplication(app, str(row.uuid) ?? null, null));
  }
  for (const svc of asArray<Record<string, unknown>>(row.services)) {
    services.push(normalizeService(svc, str(row.uuid) ?? null, null));
  }
  return {
    uuid: str(row.uuid) ?? uuid,
    name: str(row.name) ?? "(unnamed)",
    description: typeof row.description === "string" ? row.description : null,
    environments,
    applications,
    services,
    databases,
    raw,
  };
}

/**
 * Normalize one application row (list or nested shape).
 *
 * @param row - Raw API row.
 * @param projectUuid - Owning project UUID when known.
 * @param environmentName - Owning environment name when known.
 * @returns Normalized application.
 */
export function normalizeApplication(
  row: Record<string, unknown>,
  projectUuid: string | null,
  environmentName: string | null,
): CoolifyApplication {
  return {
    uuid: str(row.uuid) ?? "",
    name: str(row.name) ?? "(unnamed)",
    description: typeof row.description === "string" ? row.description : null,
    fqdn: str(row.fqdn),
    gitRepository: str(row.git_repository) ?? str(row.gitRepository),
    gitBranch: str(row.git_branch) ?? str(row.gitBranch),
    buildPack: str(row.build_pack) ?? str(row.buildPack),
    status: str(row.status),
    projectUuid: str(row.project_uuid) ?? projectUuid,
    environmentName: str(row.environment_name) ?? str(row.environment) ?? environmentName,
    updatedAt: str(row.updated_at) ?? str(row.updatedAt),
    raw: row,
  };
}

/**
 * Normalize one service row (list or nested shape).
 *
 * @param row - Raw API row.
 * @param projectUuid - Owning project UUID when known.
 * @param environmentName - Owning environment name when known.
 * @returns Normalized service.
 */
export function normalizeService(
  row: Record<string, unknown>,
  projectUuid: string | null,
  environmentName: string | null,
): CoolifyService {
  return {
    uuid: str(row.uuid) ?? "",
    name: str(row.name) ?? "(unnamed)",
    description: typeof row.description === "string" ? row.description : null,
    status: str(row.status),
    projectUuid: str(row.project_uuid) ?? projectUuid,
    environmentName: str(row.environment_name) ?? str(row.environment) ?? environmentName,
    updatedAt: str(row.updated_at) ?? str(row.updatedAt),
    raw: row,
  };
}

/**
 * List all applications on the instance.
 *
 * @param baseUrl - Normalized instance root.
 * @param apiToken - Full API token value.
 * @returns Normalized application rows.
 */
export async function listApplications(baseUrl: string, apiToken: string): Promise<readonly CoolifyApplication[]> {
  const raw = await coolifyRequest<unknown>(baseUrl, apiToken, "/api/v1/applications");
  return asArray<Record<string, unknown>>(raw)
    .map((row) => normalizeApplication(row, null, null))
    .filter((a) => a.uuid.length > 0);
}

/**
 * Fetch one application by UUID.
 *
 * @param baseUrl - Normalized instance root.
 * @param apiToken - Full API token value.
 * @param uuid - Application UUID.
 * @returns Normalized application detail (raw payload attached).
 */
export async function getApplication(
  baseUrl: string,
  apiToken: string,
  uuid: string,
): Promise<CoolifyApplication> {
  const raw = await coolifyRequest<unknown>(baseUrl, apiToken, `/api/v1/applications/${encodeURIComponent(uuid)}`);
  const row = rec(raw);
  // Single-get wraps the record under `application` on some versions.
  const inner = rec(row.application);
  const effective = str(row.uuid) !== null ? row : Object.keys(inner).length > 0 ? inner : row;
  return { ...normalizeApplication(effective, null, null), raw };
}

/**
 * List all services on the instance.
 *
 * @param baseUrl - Normalized instance root.
 * @param apiToken - Full API token value.
 * @returns Normalized service rows.
 */
export async function listServices(baseUrl: string, apiToken: string): Promise<readonly CoolifyService[]> {
  const raw = await coolifyRequest<unknown>(baseUrl, apiToken, "/api/v1/services");
  return asArray<Record<string, unknown>>(raw)
    .map((row) => normalizeService(row, null, null))
    .filter((s) => s.uuid.length > 0);
}

/**
 * List all servers on the instance.
 *
 * @param baseUrl - Normalized instance root.
 * @param apiToken - Full API token value.
 * @returns Normalized server rows.
 */
export async function listServers(baseUrl: string, apiToken: string): Promise<readonly CoolifyServer[]> {
  const raw = await coolifyRequest<unknown>(baseUrl, apiToken, "/api/v1/servers");
  return asArray<Record<string, unknown>>(raw)
    .map((row) => ({
      uuid: str(row.uuid) ?? "",
      name: str(row.name) ?? "(unnamed)",
      description: typeof row.description === "string" ? row.description : null,
      ip: str(row.ip),
      isReachable: typeof row.is_reachable === "boolean" ? row.is_reachable : typeof row.isReachable === "boolean" ? row.isReachable : null,
      raw: row,
    }))
    .filter((s) => s.uuid.length > 0);
}

/**
 * List currently running deployments.
 *
 * @param baseUrl - Normalized instance root.
 * @param apiToken - Full API token value.
 * @returns Normalized deployment rows (empty when none running).
 */
export async function listDeployments(baseUrl: string, apiToken: string): Promise<readonly CoolifyDeployment[]> {
  const raw = await coolifyRequest<unknown>(baseUrl, apiToken, "/api/v1/deployments");
  return asArray<Record<string, unknown>>(raw).map((row) => ({
    deploymentUuid: str(row.deployment_uuid) ?? str(row.uuid) ?? "",
    applicationId: str(row.application_id),
    applicationName: str(row.application_name) ?? str(row.name),
    status: str(row.status),
    currentProcessId: str(row.current_process_id),
    createdAt: str(row.created_at),
    updatedAt: str(row.updated_at),
    raw: row,
  })).filter((d) => d.deploymentUuid.length > 0);
}

/**
 * List deployments for one application.
 *
 * @param baseUrl - Normalized instance root.
 * @param apiToken - Full API token value.
 * @param appUuid - Application UUID.
 * @returns Normalized deployment rows.
 */
export async function listApplicationDeployments(
  baseUrl: string,
  apiToken: string,
  appUuid: string,
): Promise<readonly CoolifyDeployment[]> {
  const raw = await coolifyRequest<unknown>(
    baseUrl,
    apiToken,
    `/api/v1/deployments/applications/${encodeURIComponent(appUuid)}`,
  );
  const rows = Array.isArray(raw) ? raw : asArray<unknown>(rec(raw).deployments);
  return (rows as readonly Record<string, unknown>[]).map((row) => {
    const r = rec(row);
    return {
      deploymentUuid: str(r.deployment_uuid) ?? str(r.uuid) ?? "",
      applicationId: str(r.application_id) ?? appUuid,
      applicationName: str(r.application_name) ?? str(r.name),
      status: str(r.status),
      currentProcessId: str(r.current_process_id),
      createdAt: str(r.created_at),
      updatedAt: str(r.updated_at),
      raw: r,
    };
  }).filter((d) => d.deploymentUuid.length > 0 || d.status !== null);
}
