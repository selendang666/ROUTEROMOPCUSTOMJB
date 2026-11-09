/** API hooks for Coolify monitoring — connections, overview, projects, details. */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiDelete, apiGet, apiPatch, apiPost, type ApiError } from "../../lib/api";
import { toast } from "../../lib/toast";
import { qk } from "../../lib/query-keys";
import type {
  CoolifyApplication,
  CoolifyConnection,
  CoolifyDeployment,
  CoolifyOverview,
  CoolifyProbe,
  CoolifyProject,
  CoolifyProjectDetail,
  CoolifyServer,
  CoolifyService,
} from "./types";

interface ConnectionsData {
  connections: CoolifyConnection[];
}

interface ProbeData {
  probe: CoolifyProbe;
}

/** List all configured Coolify instances. */
export function useCoolifyConnections() {
  return useQuery({
    queryKey: qk.coolify.connections,
    queryFn: async () => {
      const res = await apiGet<ConnectionsData | CoolifyConnection[]>("/coolify/connections");
      return Array.isArray(res) ? res : (res.connections ?? []);
    },
  });
}

/** Aggregated snapshot (reachability + counts) for one instance. */
export function useCoolifyOverview(connectionId: string | undefined) {
  return useQuery({
    queryKey: qk.coolify.overview(connectionId),
    queryFn: () => apiGet<{ overview: CoolifyOverview }>(`/coolify/connections/${connectionId}/overview`),
    enabled: Boolean(connectionId),
    refetchInterval: 30_000,
  });
}

/** Projects deployed on one instance. */
export function useCoolifyProjects(connectionId: string | undefined) {
  return useQuery({
    queryKey: qk.coolify.projects(connectionId),
    queryFn: () => apiGet<{ projects: CoolifyProject[] }>(`/coolify/connections/${connectionId}/projects`),
    enabled: Boolean(connectionId),
    refetchInterval: 30_000,
  });
}

/** Full project detail — opened when a deployed project is clicked. */
export function useCoolifyProjectDetail(connectionId: string | undefined, uuid: string | undefined) {
  return useQuery({
    queryKey: qk.coolify.projectDetail(connectionId, uuid),
    queryFn: () =>
      apiGet<{ project: CoolifyProjectDetail }>(
        `/coolify/connections/${connectionId}/projects/${encodeURIComponent(uuid ?? "")}`,
      ),
    enabled: Boolean(connectionId) && Boolean(uuid),
    refetchInterval: 30_000,
  });
}

/** Applications deployed on one instance. */
export function useCoolifyApplications(connectionId: string | undefined) {
  return useQuery({
    queryKey: qk.coolify.applications(connectionId),
    queryFn: () => apiGet<{ applications: CoolifyApplication[] }>(`/coolify/connections/${connectionId}/applications`),
    enabled: Boolean(connectionId),
    refetchInterval: 30_000,
  });
}

/** Application detail with recent deployments. */
export function useCoolifyApplicationDetail(connectionId: string | undefined, uuid: string | undefined) {
  return useQuery({
    queryKey: qk.coolify.applicationDetail(connectionId, uuid),
    queryFn: () =>
      apiGet<{ application: CoolifyApplication; deployments: CoolifyDeployment[] }>(
        `/coolify/connections/${connectionId}/applications/${encodeURIComponent(uuid ?? "")}`,
      ),
    enabled: Boolean(connectionId) && Boolean(uuid),
    refetchInterval: 30_000,
  });
}

/** Services on one instance. */
export function useCoolifyServices(connectionId: string | undefined) {
  return useQuery({
    queryKey: qk.coolify.services(connectionId),
    queryFn: () => apiGet<{ services: CoolifyService[] }>(`/coolify/connections/${connectionId}/services`),
    enabled: Boolean(connectionId),
    refetchInterval: 30_000,
  });
}

/** Servers on one instance. */
export function useCoolifyServers(connectionId: string | undefined) {
  return useQuery({
    queryKey: qk.coolify.servers(connectionId),
    queryFn: () => apiGet<{ servers: CoolifyServer[] }>(`/coolify/connections/${connectionId}/servers`),
    enabled: Boolean(connectionId),
    refetchInterval: 60_000,
  });
}

/** Currently running deployments on one instance. */
export function useCoolifyDeployments(connectionId: string | undefined) {
  return useQuery({
    queryKey: qk.coolify.deployments(connectionId),
    queryFn: () => apiGet<{ deployments: CoolifyDeployment[] }>(`/coolify/connections/${connectionId}/deployments`),
    enabled: Boolean(connectionId),
    refetchInterval: 15_000,
  });
}

export interface SaveConnectionInput {
  name: string;
  baseUrl: string;
  apiToken: string;
}

/** Register a new instance (server probes before persisting). */
export function useSaveCoolifyConnection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SaveConnectionInput) =>
      apiPost<{ connection: CoolifyConnection; probe: CoolifyProbe }>("/coolify/connections", input),
    onSuccess: (data) => {
      toast.success(`${data.connection.name}: connected`);
      qc.invalidateQueries({ queryKey: qk.coolify.connections });
    },
    onError: (err: ApiError) => {
      toast.error(`Connection failed — ${err.message}`);
    },
  });
}

/** Probe an ad-hoc URL + token without saving. */
export function useProbeCoolify() {
  return useMutation({
    mutationFn: (input: SaveConnectionInput | { id: string }) => apiPost<ProbeData>("/coolify/test", input),
  });
}

/** Delete an instance. */
export function useDeleteCoolifyConnection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiDelete<{ removed: boolean }>(`/coolify/connections/${id}`),
    onSuccess: () => {
      toast.success("Coolify connection removed");
      qc.invalidateQueries({ queryKey: qk.coolify.connections });
    },
    onError: (err: ApiError) => {
      toast.error(`Delete failed: ${err.message}`);
    },
  });
}

/** Toggle an instance enabled/disabled. */
export function useToggleCoolifyConnection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      apiPatch<{ connection: CoolifyConnection }>(`/coolify/connections/${id}`, { enabled }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.coolify.connections });
    },
    onError: (err: ApiError) => {
      toast.error(`Update failed: ${err.message}`);
    },
  });
}
