/** Coolify detail pages — project detail and application detail. */

import { Link, useParams } from "react-router-dom";
import { ArrowLeft, Boxes, Container, ExternalLink, GitBranch, Globe, Rocket, Server } from "lucide-react";
import { Card } from "../../components/ui/card";
import { Badge } from "../../components/ui/badge";
import { StatePanel } from "../../components/ui/state";
import { getErrorMessage } from "../../lib/helpers.js";
import { useCoolifyApplicationDetail, useCoolifyConnections, useCoolifyProjectDetail } from "./api";

function statusTone(status: string | null | undefined): "ok" | "warn" | "err" | "default" | "info" {
  const s = (status ?? "").toLowerCase();
  if (/healthy|running|running:healthy|active|online|success|finished|done/.test(s)) return "ok";
  if (/failed|error|exited|stopped|unhealthy|degraded/.test(s)) return "err";
  if (/building|starting|deploying|queued|pending|restarting/.test(s)) return "warn";
  return "default";
}

function useConnectionName(connectionId: string | undefined): string {
  const connectionsQuery = useCoolifyConnections();
  if (!connectionId) return "…";
  return connectionsQuery.data?.find((c) => c.id === connectionId)?.name ?? connectionId.slice(0, 8);
}

/** Project detail — environments with their deployed applications/services. */
export function CoolifyProjectDetailPage() {
  const { connectionId, uuid } = useParams<{ connectionId: string; uuid: string }>();
  const detailQuery = useCoolifyProjectDetail(connectionId, uuid ? decodeURIComponent(uuid) : undefined);
  const connectionName = useConnectionName(connectionId);
  const project = detailQuery.data?.project ?? null;

  return (
    <div className="dashboard-page space-y-4">
      <Link to="/coolify" className="inline-flex items-center gap-1 text-[11.5px] text-[var(--accent)]">
        <ArrowLeft size={13} /> Back to Coolify ({connectionName})
      </Link>

      {detailQuery.isLoading ? (
        <StatePanel kind="loading" title="Loading project" description="Fetching project detail from Coolify…" />
      ) : detailQuery.isError || !project ? (
        <StatePanel
          kind="error"
          title="Project unavailable"
          description={getErrorMessage(detailQuery.error, "Could not load this project.")}
          icon={Boxes}
        />
      ) : (
        <>
          <Card>
            <div className="flex items-start gap-2.5">
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[10px] bg-[rgba(10,132,255,0.13)] text-[#0a84ff]">
                <Boxes size={15} />
              </span>
              <div className="min-w-0">
                <h2 className="text-sm font-bold tracking-tight">{project.name}</h2>
                <p className="truncate text-[11px] text-[var(--text-3)]">{project.description || project.uuid}</p>
              </div>
            </div>
            {(project.environments?.length ?? 0) > 0 ? (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {project.environments?.map((env) => (
                  <Badge key={env.uuid ?? env.name} tone="info">
                    {env.name}
                  </Badge>
                ))}
              </div>
            ) : null}
          </Card>

          <div>
            <h3 className="mb-2 text-[11px] font-bold uppercase tracking-wider text-[var(--text-3)]">
              Applications ({project.applications?.length ?? 0})
            </h3>
            {(project.applications?.length ?? 0) === 0 ? (
              <StatePanel kind="empty" title="No applications" description="This project has no applications." icon={Globe} />
            ) : (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {project.applications?.map((app) => (
                  <Link
                    key={app.uuid}
                    to={`/coolify/${connectionId}/applications/${encodeURIComponent(app.uuid)}`}
                    className="glass rounded-[var(--radius-card)] border border-[var(--inner-border)] p-2.5 transition-colors hover:border-[var(--accent)]/50"
                  >
                    <div className="flex items-center gap-2">
                      <Badge tone={statusTone(app.status)}>{app.status ?? "unknown"}</Badge>
                      <p className="min-w-0 flex-1 truncate text-[12px] font-semibold text-[var(--text-1)]">{app.name}</p>
                    </div>
                    {app.fqdn ? (
                      <p className="mt-1 flex items-center gap-1 truncate text-[11px] text-[var(--accent)]">
                        <ExternalLink size={11} className="shrink-0" /> {app.fqdn}
                      </p>
                    ) : null}
                    {app.gitRepository ? (
                      <p className="mt-0.5 flex items-center gap-1 truncate text-[10.5px] text-[var(--text-3)]">
                        <GitBranch size={11} className="shrink-0" /> {app.gitRepository}
                        {app.gitBranch ? ` · ${app.gitBranch}` : ""}
                      </p>
                    ) : null}
                    {app.environmentName ? (
                      <p className="mt-0.5 text-[10px] text-[var(--text-3)]">env: {app.environmentName}</p>
                    ) : null}
                  </Link>
                ))}
              </div>
            )}
          </div>

          <div>
            <h3 className="mb-2 text-[11px] font-bold uppercase tracking-wider text-[var(--text-3)]">
              Services ({project.services?.length ?? 0})
            </h3>
            {(project.services?.length ?? 0) === 0 ? (
              <p className="text-[11px] text-[var(--text-3)]">No services in this project.</p>
            ) : (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {project.services?.map((svc) => (
                  <Card key={svc.uuid}>
                    <div className="flex items-center gap-2">
                      <Container size={13} className="shrink-0 text-[var(--text-3)]" />
                      <p className="min-w-0 flex-1 truncate text-[12px] font-semibold text-[var(--text-1)]">{svc.name}</p>
                      <Badge tone={statusTone(svc.status)}>{svc.status ?? "unknown"}</Badge>
                    </div>
                    {svc.environmentName ? (
                      <p className="mt-1 text-[10px] text-[var(--text-3)]">env: {svc.environmentName}</p>
                    ) : null}
                  </Card>
                ))}
              </div>
            )}
          </div>

          {(project.databases?.length ?? 0) > 0 ? (
            <Card>
              <h3 className="mb-2 text-[11px] font-bold uppercase tracking-wider text-[var(--text-3)]">
                Databases ({project.databases?.length ?? 0})
              </h3>
              <ul className="space-y-1">
                {project.databases?.slice(0, 10).map((db, i) => (
                  <li key={i} className="truncate text-[11.5px] text-[var(--text-2)]">
                    {typeof db === "object" && db !== null
                      ? String((db as Record<string, unknown>).name ?? (db as Record<string, unknown>).uuid ?? JSON.stringify(db).slice(0, 80))
                      : String(db)}
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
        </>
      )}
    </div>
  );
}

/** Application detail — config, status, and recent deployments. */
export function CoolifyApplicationDetailPage() {
  const { connectionId, uuid } = useParams<{ connectionId: string; uuid: string }>();
  const detailQuery = useCoolifyApplicationDetail(connectionId, uuid ? decodeURIComponent(uuid) : undefined);
  const connectionName = useConnectionName(connectionId);
  const application = detailQuery.data?.application ?? null;
  const deployments = detailQuery.data?.deployments ?? [];

  return (
    <div className="dashboard-page space-y-4">
      <Link to="/coolify" className="inline-flex items-center gap-1 text-[11.5px] text-[var(--accent)]">
        <ArrowLeft size={13} /> Back to Coolify ({connectionName})
      </Link>

      {detailQuery.isLoading ? (
        <StatePanel kind="loading" title="Loading application" description="Fetching application detail…" />
      ) : detailQuery.isError || !application ? (
        <StatePanel
          kind="error"
          title="Application unavailable"
          description={getErrorMessage(detailQuery.error, "Could not load this application.")}
          icon={Globe}
        />
      ) : (
        <>
          <Card>
            <div className="flex flex-wrap items-start gap-2.5">
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[10px] bg-[rgba(10,132,255,0.13)] text-[#0a84ff]">
                <Globe size={15} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <h2 className="text-sm font-bold tracking-tight">{application.name}</h2>
                  <Badge tone={statusTone(application.status)}>{application.status ?? "unknown"}</Badge>
                </div>
                <p className="truncate text-[11px] text-[var(--text-3)]">
                  {application.description || application.uuid}
                </p>
              </div>
            </div>
            <dl className="mt-3 grid grid-cols-1 gap-1.5 text-[11.5px] sm:grid-cols-2">
              <DetailRow label="FQDN" value={application.fqdn} href={application.fqdn ?? undefined} />
              <DetailRow label="Repository" value={application.gitRepository} />
              <DetailRow label="Branch" value={application.gitBranch} />
              <DetailRow label="Build pack" value={application.buildPack} />
              <DetailRow label="Environment" value={application.environmentName} />
              <DetailRow label="Updated" value={application.updatedAt} />
            </dl>
          </Card>

          <div>
            <h3 className="mb-2 flex items-center gap-1 text-[11px] font-bold uppercase tracking-wider text-[var(--text-3)]">
              <Rocket size={11} /> Deployments ({deployments.length})
            </h3>
            {deployments.length === 0 ? (
              <StatePanel kind="empty" title="No deployments" description="No deployment history for this app." icon={Rocket} />
            ) : (
              <div className="space-y-1.5">
                {deployments.slice(0, 20).map((d, i) => (
                  <Card key={d.deploymentUuid || i}>
                    <div className="flex items-center gap-2">
                      <Badge tone={statusTone(d.status)}>{d.status ?? "unknown"}</Badge>
                      <span className="min-w-0 flex-1 truncate text-[11.5px] text-[var(--text-2)]">
                        {d.deploymentUuid || "—"}
                      </span>
                      {d.updatedAt ? (
                        <span className="shrink-0 text-[10px] text-[var(--text-3)]">{d.updatedAt}</span>
                      ) : null}
                    </div>
                  </Card>
                ))}
              </div>
            )}
          </div>

          <p className="flex items-center gap-1 text-[10.5px] text-[var(--text-3)]">
            <Server size={11} /> Manage, redeploy, or open logs from your Coolify instance.
          </p>
        </>
      )}
    </div>
  );
}

function DetailRow({ label, value, href }: { label: string; value: string | null | undefined; href?: string }) {
  if (!value) return null;
  return (
    <div className="flex min-w-0 items-center gap-2">
      <dt className="shrink-0 text-[var(--text-3)]">{label}:</dt>
      <dd className="min-w-0 flex-1 truncate text-[var(--text-1)]">
        {href ? (
          <a href={href.startsWith("http") ? href : `https://${href}`} target="_blank" rel="noreferrer" className="text-[var(--accent)]">
            {value}
          </a>
        ) : (
          value
        )}
      </dd>
    </div>
  );
}
