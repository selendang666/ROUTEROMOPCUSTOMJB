/** Coolify monitoring page — instance input, overview stats, deployed projects. */

import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowRight,
  Boxes,
  CheckCircle2,
  Container,
  Database,
  ExternalLink,
  Globe,
  HardDrive,
  Plus,
  RefreshCw,
  Rocket,
  Server,
  Trash2,
  XCircle,
} from "lucide-react";
import { cn } from "../../lib/cn";
import { getErrorMessage } from "../../lib/helpers.js";
import { Card } from "../../components/ui/card";
import { Button } from "../../components/ui/button";
import { Badge } from "../../components/ui/badge";
import { Input, Label } from "../../components/ui/input";
import { Switch } from "../../components/ui/switch";
import { StatePanel, StatCard } from "../../components/ui/state";
import { ConfirmDialog } from "../../components/shared";
import {
  useCoolifyApplications,
  useCoolifyConnections,
  useCoolifyDeployments,
  useCoolifyOverview,
  useCoolifyProjects,
  useDeleteCoolifyConnection,
  useProbeCoolify,
  useSaveCoolifyConnection,
  useToggleCoolifyConnection,
} from "./api";

function statusTone(status: string | null | undefined): "ok" | "warn" | "err" | "default" {
  const s = (status ?? "").toLowerCase();
  if (/healthy|running|running:healthy|active|online|success|finished|done/.test(s)) return "ok";
  if (/failed|error|exited|stopped|unhealthy|degraded/.test(s)) return "err";
  if (/building|starting|deploying|queued|pending|restarting/.test(s)) return "warn";
  return "default";
}

/**
 * Public URL of the full Coolify admin UI (tunneled subdomain).
 * The stored connection `baseUrl` stays on the loopback address because the
 * backend calls the Coolify API server-side; this is only the browser link
 * for full management (deploy, settings) next to the read-only monitoring.
 */
const COOLIFY_UI_URL = "https://coolify.claudepeak.com";

export function CoolifyPage() {
  const connectionsQuery = useCoolifyConnections();
  const connections = useMemo(() => connectionsQuery.data ?? [], [connectionsQuery.data]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  useEffect(() => {
    if (selectedId === null && connections.length > 0) {
      setSelectedId(connections[0]?.id ?? null);
    }
    if (selectedId !== null && !connections.some((c) => c.id === selectedId)) {
      setSelectedId(connections[0]?.id ?? null);
    }
  }, [connections, selectedId]);

  const selected = connections.find((c) => c.id === selectedId) ?? null;
  const overviewQuery = useCoolifyOverview(selected?.id);
  const projectsQuery = useCoolifyProjects(selected?.id);
  const appsQuery = useCoolifyApplications(selected?.id);
  const deploymentsQuery = useCoolifyDeployments(selected?.id);
  const deleteMutation = useDeleteCoolifyConnection();
  const toggleMutation = useToggleCoolifyConnection();

  const overview = overviewQuery.data?.overview ?? null;
  const projects = projectsQuery.data?.projects ?? [];
  const apps = appsQuery.data?.applications ?? [];
  const deployments = deploymentsQuery.data?.deployments ?? [];

  return (
    <div className="dashboard-page space-y-4">
      <Card>
        <div className="flex flex-wrap items-start gap-2.5">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[10px] bg-[rgba(10,132,255,0.13)] text-[#0a84ff]">
            <Server size={15} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-bold tracking-tight">Coolify Monitoring</h2>
            <p className="text-[11.5px] text-[var(--text-2)]">
              Connect a Coolify instance, then open any deployed project to see its detail.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button variant="secondary" onClick={() => window.open(COOLIFY_UI_URL, "_blank", "noopener")}>
              <ExternalLink size={13} /> Coolify UI
            </Button>
            {selected !== null && (
              <Button
                variant="secondary"
                onClick={() => {
                  void overviewQuery.refetch();
                  void projectsQuery.refetch();
                  void appsQuery.refetch();
                  void deploymentsQuery.refetch();
                }}
              >
                <RefreshCw size={13} /> Refresh
              </Button>
            )}
            <Button onClick={() => setShowForm((v) => !v)}>
              <Plus size={13} /> {connections.length === 0 ? "Connect instance" : "Add instance"}
            </Button>
          </div>
        </div>
      </Card>

      {showForm || connections.length === 0 ? <ConnectionForm onSaved={() => setShowForm(false)} /> : null}

      {connectionsQuery.isLoading ? (
        <StatePanel kind="loading" title="Loading instances" description="Reading Coolify connections…" />
      ) : connectionsQuery.isError ? (
        <StatePanel kind="error" title="Failed to load" description="Could not load Coolify connections." icon={Server} />
      ) : connections.length === 0 ? (
        <StatePanel
          kind="empty"
          title="No Coolify instance connected"
          description="Paste your Coolify URL and an API token (Keys & Tokens → API tokens) above to start monitoring."
          icon={Server}
        />
      ) : (
        <>
          {connections.length > 1 ? (
            <div className="flex flex-wrap gap-1.5">
              {connections.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setSelectedId(c.id)}
                  className={cn(
                    "rounded-full border px-2.5 py-1 text-[11px] font-semibold transition-colors",
                    c.id === selected?.id
                      ? "border-[var(--accent)]/60 bg-[var(--accent)]/10 text-[var(--text-1)]"
                      : "border-[var(--inner-border)] text-[var(--text-3)] hover:text-[var(--text-1)]",
                  )}
                >
                  {c.name}
                </button>
              ))}
            </div>
          ) : null}

          {selected !== null ? (
            <Card>
              <div className="flex flex-wrap items-center gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    {overview?.reachable === true ? (
                      <CheckCircle2 size={13} className="shrink-0 text-[var(--status-success)]" />
                    ) : overview?.reachable === false ? (
                      <XCircle size={13} className="shrink-0 text-[var(--status-danger)]" />
                    ) : (
                      <RefreshCw size={13} className="shrink-0 animate-spin text-[var(--text-3)]" />
                    )}
                    <p className="truncate text-[12.5px] font-bold text-[var(--text-1)]">{selected.name}</p>
                    {!selected.enabled ? <Badge tone="warn">disabled</Badge> : null}
                  </div>
                  <p className="mt-0.5 truncate text-[11px] text-[var(--text-3)]">
                    {selected.baseUrl}
                    {overview?.version ? ` · v${overview.version}` : ""}
                    {overview?.team ? ` · ${overview.team}` : ""}
                    {overview?.latencyMs != null ? ` · ${overview.latencyMs}ms` : ""}
                  </p>
                  {overview?.reachable === false && overview.error ? (
                    <p className="mt-1 text-[11px] text-[var(--status-danger)]">{overview.error}</p>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Switch
                    checked={selected.enabled}
                    onChange={(v) => toggleMutation.mutate({ id: selected.id, enabled: v })}
                    label="Enabled"
                  />
                  <Button variant="danger" onClick={() => setPendingDelete(selected.id)}>
                    <Trash2 size={13} />
                  </Button>
                </div>
              </div>
            </Card>
          ) : null}

          {overview?.counts ? (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5">
              <StatCard label="Projects" value={overview.counts.projects} icon={Boxes} loading={overviewQuery.isLoading} />
              <StatCard label="Applications" value={overview.counts.applications} icon={Globe} loading={overviewQuery.isLoading} />
              <StatCard label="Services" value={overview.counts.services} icon={Container} loading={overviewQuery.isLoading} />
              <StatCard label="Servers" value={overview.counts.servers} icon={HardDrive} loading={overviewQuery.isLoading} />
              <StatCard
                label="Running deploys"
                value={overview.counts.runningDeployments}
                icon={Rocket}
                tone={overview.counts.runningDeployments > 0 ? "info" : "neutral"}
                loading={overviewQuery.isLoading}
              />
            </div>
          ) : null}

          <div>
            <h3 className="mb-2 text-[11px] font-bold uppercase tracking-wider text-[var(--text-3)]">
              Projects ({projects.length})
            </h3>
            {projectsQuery.isLoading ? (
              <StatePanel kind="loading" title="Loading projects" description="Querying the Coolify API…" />
            ) : projectsQuery.isError ? (
              <StatePanel
                kind="error"
                title="Projects unavailable"
                description={getErrorMessage(projectsQuery.error, "Coolify API rejected the projects request.")}
                icon={Boxes}
              />
            ) : projects.length === 0 ? (
              <StatePanel kind="empty" title="No projects" description="This instance has no projects yet." icon={Boxes} />
            ) : (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {projects.map((p) => (
                  <Link
                    key={p.uuid}
                    to={`/coolify/${selected?.id}/projects/${encodeURIComponent(p.uuid)}`}
                    className="glass flex items-center gap-2.5 rounded-[var(--radius-card)] border border-[var(--inner-border)] p-2.5 transition-colors hover:border-[var(--accent)]/50"
                  >
                    <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[10px] bg-[rgba(10,132,255,0.13)] text-[#0a84ff]">
                      <Boxes size={15} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[12px] font-semibold text-[var(--text-1)]">{p.name}</p>
                      <p className="truncate text-[10px] text-[var(--text-3)]">{p.description || p.uuid}</p>
                    </div>
                    <ArrowRight size={14} className="shrink-0 text-[var(--text-3)]" />
                  </Link>
                ))}
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
            <Card>
              <h3 className="mb-2 text-[11px] font-bold uppercase tracking-wider text-[var(--text-3)]">
                Applications ({apps.length})
              </h3>
              {appsQuery.isLoading ? (
                <p className="text-[11px] text-[var(--text-3)]">Loading…</p>
              ) : apps.length === 0 ? (
                <p className="text-[11px] text-[var(--text-3)]">No applications deployed.</p>
              ) : (
                <ul className="space-y-1.5">
                  {apps.slice(0, 8).map((a) => (
                    <li key={a.uuid}>
                      <Link
                        to={`/coolify/${selected?.id}/applications/${encodeURIComponent(a.uuid)}`}
                        className="flex items-center gap-2 rounded-lg px-1.5 py-1 transition-colors hover:bg-[var(--surface-muted)]"
                      >
                        <Badge tone={statusTone(a.status)}>{a.status ?? "unknown"}</Badge>
                        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-[var(--text-1)]">{a.name}</span>
                        {a.fqdn ? (
                          <span className="hidden max-w-[40%] truncate text-[10px] text-[var(--text-3)] sm:inline">{a.fqdn}</span>
                        ) : null}
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Card>
              <h3 className="mb-2 text-[11px] font-bold uppercase tracking-wider text-[var(--text-3)]">
                Running deployments ({deployments.length})
              </h3>
              {deploymentsQuery.isLoading ? (
                <p className="text-[11px] text-[var(--text-3)]">Loading…</p>
              ) : deployments.length === 0 ? (
                <p className="text-[11px] text-[var(--text-3)]">
                  <Database size={11} className="mr-1 inline" />
                  Nothing deploying right now.
                </p>
              ) : (
                <ul className="space-y-1.5">
                  {deployments.slice(0, 8).map((d) => (
                    <li key={d.deploymentUuid} className="flex items-center gap-2 px-1.5 py-1">
                      <Badge tone={statusTone(d.status)}>{d.status ?? "running"}</Badge>
                      <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--text-1)]">
                        {d.applicationName ?? d.deploymentUuid}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </>
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        onConfirm={() => {
          if (pendingDelete !== null) deleteMutation.mutate(pendingDelete);
        }}
        title="Remove instance?"
        message="The stored URL and API token will be deleted. Deployments on Coolify are not affected."
        confirmLabel="Remove"
        danger
      />
    </div>
  );
}

function ConnectionForm({ onSaved }: { onSaved: () => void }) {
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiToken, setApiToken] = useState("");
  const [probeMessage, setProbeMessage] = useState<string | null>(null);
  const saveMutation = useSaveCoolifyConnection();
  const probeMutation = useProbeCoolify();

  const canSubmit = name.trim().length > 0 && baseUrl.trim().length > 0 && apiToken.trim().length > 0;

  return (
    <Card>
      <h3 className="mb-1 text-[12.5px] font-bold text-[var(--text-1)]">Connect Coolify instance</h3>
      <p className="mb-3 text-[11px] text-[var(--text-3)]">
        The token is stored encrypted server-side (APP_SECRET) and never exposed again. Enable API access on
        self-hosted instances first.
      </p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <div>
          <Label htmlFor="coolify-name">Name</Label>
          <Input id="coolify-name" placeholder="homelab" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="coolify-url">Coolify URL</Label>
          <Input
            id="coolify-url"
            placeholder="https://coolify.example.com"
            inputMode="url"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="coolify-token">API token</Label>
          <Input
            id="coolify-token"
            type="password"
            placeholder="id|secret"
            value={apiToken}
            onChange={(e) => setApiToken(e.target.value)}
          />
        </div>
      </div>
      {probeMessage !== null ? <p className="mt-2 text-[11px] text-[var(--text-2)]">{probeMessage}</p> : null}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          variant="secondary"
          disabled={!canSubmit || probeMutation.isPending}
          onClick={() =>
            probeMutation.mutate(
              { name: name.trim(), baseUrl: baseUrl.trim(), apiToken: apiToken.trim() },
              {
                onSuccess: (data) =>
                  setProbeMessage(
                    data.probe.ok
                      ? `Reachable${data.probe.team ? ` · team ${data.probe.team}` : ""}${data.probe.version ? ` · v${data.probe.version}` : ""} (${data.probe.latencyMs}ms)`
                      : `Unreachable — ${data.probe.error ?? "probe failed"}`,
                  ),
                onError: (err) => setProbeMessage(`Probe failed — ${getErrorMessage(err)}`),
              },
            )
          }
        >
          {probeMutation.isPending ? "Testing…" : "Test connection"}
        </Button>
        <Button
          disabled={!canSubmit || saveMutation.isPending}
          onClick={() =>
            saveMutation.mutate(
              { name: name.trim(), baseUrl: baseUrl.trim(), apiToken: apiToken.trim() },
              {
                onSuccess: () => {
                  setName("");
                  setBaseUrl("");
                  setApiToken("");
                  setProbeMessage(null);
                  onSaved();
                },
              },
            )
          }
        >
          {saveMutation.isPending ? "Connecting…" : "Save & connect"}
        </Button>
      </div>
    </Card>
  );
}
