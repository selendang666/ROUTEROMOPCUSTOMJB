/** Coolify monitoring dashboard types — mirrors `src/console/coolify/types.ts`. */

export interface CoolifyConnection {
  id: string;
  name: string;
  baseUrl: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CoolifyProbe {
  ok: boolean;
  version?: string | null;
  team?: string | null;
  latencyMs: number;
  error?: string;
}

export interface CoolifyEnvironment {
  id?: number;
  name: string;
  uuid?: string | null;
}

export interface CoolifyProject {
  uuid: string;
  name: string;
  description?: string | null;
}

export interface CoolifyApplication {
  uuid: string;
  name: string;
  description?: string | null;
  fqdn?: string | null;
  gitRepository?: string | null;
  gitBranch?: string | null;
  buildPack?: string | null;
  status?: string | null;
  projectUuid?: string | null;
  environmentName?: string | null;
  updatedAt?: string | null;
  raw?: unknown;
}

export interface CoolifyService {
  uuid: string;
  name: string;
  description?: string | null;
  status?: string | null;
  projectUuid?: string | null;
  environmentName?: string | null;
  updatedAt?: string | null;
}

export interface CoolifyServer {
  uuid: string;
  name: string;
  description?: string | null;
  ip?: string | null;
  isReachable?: boolean | null;
}

export interface CoolifyDeployment {
  deploymentUuid: string;
  applicationId?: string | null;
  applicationName?: string | null;
  status?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface CoolifyProjectDetail extends CoolifyProject {
  environments?: CoolifyEnvironment[];
  applications?: CoolifyApplication[];
  services?: CoolifyService[];
  databases?: unknown[];
}

export interface CoolifyOverview {
  connection: CoolifyConnection;
  reachable: boolean;
  version?: string | null;
  team?: string | null;
  latencyMs?: number | null;
  error?: string | null;
  counts?: {
    projects: number;
    applications: number;
    services: number;
    servers: number;
    runningDeployments: number;
  };
}
