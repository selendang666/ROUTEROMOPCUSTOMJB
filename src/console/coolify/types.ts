/**
 * Coolify monitoring shapes — single owner of the Coolify API surface used
 * by the console monitoring dashboard.
 *
 * Coolify v4 REST API: `{baseUrl}/api/v1/*` with
 * `Authorization: Bearer <api-token>` (full token value, `id|secret` intact).
 * Reference: https://coolify.io/docs/api/overview
 */

/** A configured Coolify instance (token never leaves the server). */
export interface CoolifyConnection {
  readonly id: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Input accepted when registering/updating a Coolify instance. */
export interface CoolifyConnectionInput {
  readonly name: string;
  readonly baseUrl: string;
  readonly apiToken: string;
  readonly enabled?: boolean;
}

/** Minimal project row from `GET /api/v1/projects`. */
export interface CoolifyProject {
  readonly uuid: string;
  readonly name: string;
  readonly description?: string | null;
  readonly environments?: readonly CoolifyEnvironment[];
  readonly raw?: unknown;
}

/** Environment inside a project detail payload. */
export interface CoolifyEnvironment {
  readonly id?: number;
  readonly name: string;
  readonly uuid?: string;
  readonly raw?: unknown;
}

/** Full project payload from `GET /api/v1/projects/{uuid}`. */
export interface CoolifyProjectDetail extends CoolifyProject {
  readonly applications?: readonly CoolifyApplication[];
  readonly services?: readonly CoolifyService[];
  readonly databases?: readonly unknown[];
}

/** Minimal application row from `GET /api/v1/applications`. */
export interface CoolifyApplication {
  readonly uuid: string;
  readonly name: string;
  readonly description?: string | null;
  readonly fqdn?: string | null;
  readonly gitRepository?: string | null;
  readonly gitBranch?: string | null;
  readonly buildPack?: string | null;
  readonly status?: string | null;
  readonly projectUuid?: string | null;
  readonly environmentName?: string | null;
  readonly updatedAt?: string | null;
  readonly raw?: unknown;
}

/** Minimal service row from `GET /api/v1/services`. */
export interface CoolifyService {
  readonly uuid: string;
  readonly name: string;
  readonly description?: string | null;
  readonly status?: string | null;
  readonly projectUuid?: string | null;
  readonly environmentName?: string | null;
  readonly updatedAt?: string | null;
  readonly raw?: unknown;
}

/** Minimal server row from `GET /api/v1/servers`. */
export interface CoolifyServer {
  readonly uuid: string;
  readonly name: string;
  readonly description?: string | null;
  readonly ip?: string | null;
  readonly isReachable?: boolean | null;
  readonly raw?: unknown;
}

/** Deployment row from `GET /api/v1/deployments*`. */
export interface CoolifyDeployment {
  readonly deploymentUuid: string;
  readonly applicationId?: string | null;
  readonly applicationName?: string | null;
  readonly status?: string | null;
  readonly currentProcessId?: string | null;
  readonly createdAt?: string | null;
  readonly updatedAt?: string | null;
  readonly raw?: unknown;
}

/** Result of probing a Coolify instance (`/api/v1/teams/current`). */
export interface CoolifyProbeResult {
  readonly ok: boolean;
  readonly version?: string | null;
  readonly team?: string | null;
  readonly latencyMs: number;
  readonly error?: string;
}

/** Aggregated dashboard snapshot for one connection. */
export interface CoolifyOverview {
  readonly connection: CoolifyConnection;
  readonly reachable: boolean;
  readonly version?: string | null;
  readonly team?: string | null;
  readonly latencyMs?: number | null;
  readonly error?: string | null;
  readonly counts?: {
    readonly projects: number;
    readonly applications: number;
    readonly services: number;
    readonly servers: number;
    readonly runningDeployments: number;
  };
}
