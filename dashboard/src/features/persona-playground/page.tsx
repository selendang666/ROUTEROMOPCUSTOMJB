import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  Bot,
  CheckCircle2,
  CloudCog,
  HardDrive,
  HelpCircle,
  MemoryStick,
  RefreshCw,
  Save,
  Server,
  Upload,
  XCircle,
} from "lucide-react";
import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardHeader } from "../../components/ui/card";
import { Input, Label, Textarea } from "../../components/ui/input";
import { StatePanel, StatCard } from "../../components/ui/state";
import { Switch } from "../../components/ui/switch";
import { apiGet, apiPatch, apiPost, apiPostForm } from "../../lib/api";
import { formatMemoryMb, formatUptime } from "../../lib/format";
import { getErrorMessage } from "../../lib/helpers.js";
import { qk } from "../../lib/query-keys";
import { toast } from "../../lib/toast";

interface Persona {
  enabled: boolean;
  name: string;
  version: string;
  chars: number;
  preview: string;
  updatedAt: string;
  hermesSyncedAt: string | null;
  hermesHome: string;
}

interface PersonaResult extends Persona {
  files?: string[];
  sync?: {
    home: string;
    soulPath: string;
    backedUp: boolean;
    at: string;
  };
}

interface PersonaPatch {
  enabled?: boolean;
  name?: string;
  version?: string;
  content?: string;
}

interface MonitoredService {
  id: string;
  unit: string;
  label: string;
  active: string;
  sub: string | null;
}

interface VpsStats {
  load1: number;
  load5: number;
  load15: number;
  memTotalMb: number;
  memFreeMb: number;
  memUsedPct: number;
  uptimeSec: number;
  diskUsedPct: number | null;
}

interface MonitorStatus {
  at: string;
  services: MonitoredService[];
  vps: VpsStats;
}

const MAX_PACK_BYTES = 100 * 1000 * 1000;
const MAX_CONTENT_CHARS = 65_536;

function displayTimestamp(value: string | null): string {
  if (!value) return "Never";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function serviceTone(active: string): "ok" | "err" | "default" {
  if (active === "active") return "ok";
  if (active === "failed" || active === "inactive") return "err";
  return "default";
}

function ServiceIcon({ active }: { active: string }) {
  if (active === "active") return <CheckCircle2 size={14} className="shrink-0 text-[var(--status-success)]" />;
  if (active === "failed" || active === "inactive") {
    return <XCircle size={14} className="shrink-0 text-[var(--status-danger)]" />;
  }
  return <HelpCircle size={14} className="shrink-0 text-[var(--text-3)]" />;
}

export function PersonaPlaygroundPage() {
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [version, setVersion] = useState("");
  const [content, setContent] = useState("");
  const [pack, setPack] = useState<File | null>(null);

  const personaQuery = useQuery({
    queryKey: qk.persona.all,
    queryFn: () => apiGet<Persona>("/persona"),
  });

  const monitorQuery = useQuery({
    queryKey: qk.persona.monitor,
    queryFn: () => apiGet<MonitorStatus>("/system/monitor"),
  });

  useEffect(() => {
    if (!personaQuery.data) return;
    setName(personaQuery.data.name);
    setVersion(personaQuery.data.version);
    setContent(personaQuery.data.preview);
  }, [personaQuery.data]);

  const saveMutation = useMutation({
    mutationFn: (input: { patch: PersonaPatch; successMessage: string }) =>
      apiPatch<PersonaResult>("/persona", input.patch).then((result) => ({
        result,
        successMessage: input.successMessage,
      })),
    onSuccess: ({ result, successMessage }) => {
      queryClient.setQueryData<Persona>(qk.persona.all, result);
      toast.success(successMessage);
    },
    onError: (error) => toast.error(getErrorMessage(error, "Unable to update persona")),
  });

  const syncMutation = useMutation({
    mutationFn: () => apiPost<PersonaResult>("/persona/sync-hermes"),
    onSuccess: (result) => {
      queryClient.setQueryData<Persona>(qk.persona.all, result);
      toast.success("Persona synced to Hermes");
    },
    onError: (error) => toast.error(getErrorMessage(error, "Unable to sync persona to Hermes")),
  });

  const uploadMutation = useMutation({
    mutationFn: (file: File) => {
      const form = new FormData();
      form.append("file", file);
      return apiPostForm<PersonaResult>("/persona/upload", form);
    },
    onSuccess: (result) => {
      queryClient.setQueryData<Persona>(qk.persona.all, result);
      setPack(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      toast.success(`Persona pack uploaded${result.files?.length ? ` with ${result.files.length} extra files` : ""}`);
    },
    onError: (error) => toast.error(getErrorMessage(error, "Unable to upload persona pack")),
  });

  const persona = personaQuery.data;
  const contentChanged = content !== (persona?.preview ?? "");
  const hasContent = content.trim().length > 0;
  const hasContentToSave = !contentChanged || hasContent;
  const canSave =
    hasContentToSave &&
    name.length <= 64 &&
    version.length <= 32 &&
    !saveMutation.isPending;

  const choosePack = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0] ?? null;
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".zip")) {
      event.currentTarget.value = "";
      toast.error("Persona packs must be ZIP files");
      return;
    }
    if (file.size > MAX_PACK_BYTES) {
      event.currentTarget.value = "";
      toast.error("Persona packs must be 100 MB or smaller");
      return;
    }
    setPack(file);
  };

  return (
    <div className="dashboard-page space-y-4">
      <Card density="comfortable" surface="elevated">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardHeader
            title="Persona Playground"
            sub="Manage the global persona, Hermes profile, and host services."
            icon={Bot}
          />
          {persona ? (
            <div className="flex items-center gap-2">
              <Badge tone={persona.enabled ? "ok" : "default"}>{persona.enabled ? "Enabled" : "Disabled"}</Badge>
              <Switch
                checked={persona.enabled}
                disabled={persona.chars === 0 || saveMutation.isPending}
                onChange={(enabled) =>
                  saveMutation.mutate({
                    patch: { enabled },
                    successMessage: enabled ? "Global persona enabled" : "Global persona disabled",
                  })
                }
                label="Enable global persona"
              />
            </div>
          ) : null}
        </div>
      </Card>

      {personaQuery.isLoading ? (
        <StatePanel kind="loading" title="Loading persona" description="Reading the current global persona…" icon={Bot} />
      ) : personaQuery.isError || !persona ? (
        <StatePanel
          kind="error"
          title="Persona unavailable"
          description={getErrorMessage(personaQuery.error, "The persona service did not return a status.")}
          icon={Bot}
        />
      ) : (
        <div className="grid items-start gap-4 lg:grid-cols-[1.3fr_1fr]">
          <Card density="comfortable" surface="elevated">
            <CardHeader
              title="Global Persona"
              sub={`${persona.chars.toLocaleString()} characters · Updated ${displayTimestamp(persona.updatedAt)}`}
              icon={CloudCog}
            />
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="persona-name">Name</Label>
                <Input
                  id="persona-name"
                  maxLength={64}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="custom"
                />
              </div>
              <div>
                <Label htmlFor="persona-version">Version</Label>
                <Input
                  id="persona-version"
                  maxLength={32}
                  value={version}
                  onChange={(event) => setVersion(event.target.value)}
                  placeholder="1"
                />
              </div>
            </div>
            <div className="mt-3">
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <Label htmlFor="persona-content">Content</Label>
                <span className="text-[10px] tabular-nums text-[var(--text-3)]">
                  {content.length.toLocaleString()} / {MAX_CONTENT_CHARS.toLocaleString()}
                </span>
              </div>
              <Textarea
                id="persona-content"
                className="min-h-72 font-mono text-xs leading-5"
                maxLength={MAX_CONTENT_CHARS}
                value={content}
                onChange={(event) => setContent(event.target.value)}
                placeholder="Enter the global persona content"
              />
              {persona.chars > persona.preview.length ? (
                <p className="mt-1.5 text-[11px] text-[var(--status-warning)]">
                  The API returns only the first {persona.preview.length} characters. Unchanged content is not submitted; editing it replaces the full stored content.
                </p>
              ) : null}
            </div>
            <div className="mt-3 flex justify-end">
              <Button
                disabled={!canSave}
                onClick={() =>
                  saveMutation.mutate({
                    patch: {
                      name,
                      version,
                      ...(contentChanged ? { content } : {}),
                    },
                    successMessage: "Global persona saved",
                  })
                }
              >
                <Save size={13} /> {saveMutation.isPending ? "Saving…" : "Save changes"}
              </Button>
            </div>
          </Card>

          <div className="space-y-4">
            <Card density="comfortable" surface="elevated">
              <CardHeader title="Hermes Sync" sub={`Home: ${persona.hermesHome}`} icon={RefreshCw} />
              <div className="rounded-[var(--radius-control)] border border-[var(--inner-border)] bg-[var(--hover)] p-3">
                <p className="text-xs font-semibold text-[var(--text-1)]">Last synchronized</p>
                <p className="mt-1 text-[11px] text-[var(--text-3)]">{displayTimestamp(persona.hermesSyncedAt)}</p>
              </div>
              <Button
                className="mt-3 w-full"
                variant="secondary"
                disabled={persona.chars === 0 || syncMutation.isPending}
                onClick={() => syncMutation.mutate()}
              >
                <RefreshCw size={13} className={syncMutation.isPending ? "animate-spin" : ""} />
                {syncMutation.isPending ? "Syncing…" : "Sync Hermes"}
              </Button>
            </Card>

            <Card density="comfortable" surface="elevated">
              <CardHeader title="ZIP Persona Pack" sub="Uploading activates the pack and synchronizes Hermes." icon={Upload} />
              <input
                ref={fileInputRef}
                type="file"
                accept=".zip,application/zip"
                className="hidden"
                onChange={choosePack}
              />
              <div className="rounded-[var(--radius-control)] border border-dashed border-[var(--inner-border)] bg-[var(--hover)] p-4 text-center">
                <p className="truncate text-xs font-semibold text-[var(--text-1)]">{pack?.name ?? "No ZIP pack selected"}</p>
                 <p className="mt-1 text-[10.5px] text-[var(--text-3)]">Maximum 100 MB · persona.yaml + SOUL.md</p>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button variant="secondary" onClick={() => fileInputRef.current?.click()}>
                  <Upload size={13} /> Select ZIP
                </Button>
                <Button
                  disabled={!pack || uploadMutation.isPending}
                  onClick={() => {
                    if (pack) uploadMutation.mutate(pack);
                  }}
                >
                  <Upload size={13} /> {uploadMutation.isPending ? "Uploading…" : "Upload & activate"}
                </Button>
              </div>
            </Card>
          </div>
        </div>
      )}

      <Card density="comfortable" surface="elevated">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <CardHeader
            title="VPS & Services"
            sub={monitorQuery.data ? `Sampled ${displayTimestamp(monitorQuery.data.at)}` : "Read live host and systemd service status."}
            icon={Server}
          />
          <Button
            variant="secondary"
            disabled={monitorQuery.isFetching}
            onClick={() => void monitorQuery.refetch()}
          >
            <RefreshCw size={13} className={monitorQuery.isFetching ? "animate-spin" : ""} />
            {monitorQuery.isFetching ? "Refreshing…" : "Refresh monitor"}
          </Button>
        </div>

        {monitorQuery.isLoading ? (
          <StatePanel kind="loading" title="Loading monitor" description="Checking VPS and systemd services…" icon={Activity} />
        ) : monitorQuery.isError || !monitorQuery.data ? (
          <StatePanel
            kind="error"
            title="Monitor unavailable"
            description={getErrorMessage(monitorQuery.error, "The system monitor did not return a status.")}
            icon={Activity}
          />
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-2 lg:grid-cols-5">
              <StatCard
                label="Load average"
                value={monitorQuery.data.vps.load1.toFixed(2)}
                description={`${monitorQuery.data.vps.load5.toFixed(2)} · ${monitorQuery.data.vps.load15.toFixed(2)}`}
                icon={Activity}
                loading={monitorQuery.isFetching}
              />
              <StatCard
                label="Memory"
                value={`${monitorQuery.data.vps.memUsedPct}%`}
                description={`${formatMemoryMb(monitorQuery.data.vps.memFreeMb)} free`}
                icon={MemoryStick}
                tone="info"
                loading={monitorQuery.isFetching}
              />
              <StatCard
                label="Disk"
                value={monitorQuery.data.vps.diskUsedPct === null ? "—" : `${monitorQuery.data.vps.diskUsedPct}%`}
                description="Root filesystem"
                icon={HardDrive}
                loading={monitorQuery.isFetching}
              />
              <StatCard
                label="Uptime"
                value={formatUptime(monitorQuery.data.vps.uptimeSec)}
                description={`${formatMemoryMb(monitorQuery.data.vps.memTotalMb)} total memory`}
                tone="success"
                loading={monitorQuery.isFetching}
              />
              <StatCard
                label="Services active"
                value={`${monitorQuery.data.services.filter((service) => service.active === "active").length}/${monitorQuery.data.services.length}`}
                description="systemd user units"
                tone="success"
                loading={monitorQuery.isFetching}
              />
            </div>

            <div>
              <h3 className="mb-2 text-[11px] font-bold uppercase tracking-wider text-[var(--text-3)]">Systemd Services</h3>
              <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                {monitorQuery.data.services.map((service) => (
                  <div key={service.id} className="flex items-center gap-2 rounded-[var(--radius-control)] border border-[var(--inner-border)] bg-[var(--hover)] p-3">
                    <ServiceIcon active={service.active} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-semibold text-[var(--text-1)]">{service.label}</p>
                      <p className="truncate text-[10px] text-[var(--text-3)]">{service.unit}</p>
                    </div>
                    <Badge tone={serviceTone(service.active)}>{service.sub ?? service.active}</Badge>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
