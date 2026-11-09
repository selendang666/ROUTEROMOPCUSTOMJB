/**
 * Settings — full rewrite, no tabs, all visible, reusable Card style.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { AlertTriangle, Database, Download, Eye, FileJson, HardDrive, KeyRound, Lock, Shield, SlidersHorizontal, Trash2, Upload } from "lucide-react";
import { toast } from "../../lib/toast";
import { apiGet, apiPatch, apiPost, apiDownload } from "../../lib/api";
import { getErrorMessage } from "../../lib/helpers.js";
import { downloadBlob, readJsonFile } from "../../lib/files";
import { qk } from "../../lib/query-keys";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardHeader } from "../../components/ui/card";
import { Input, Label } from "../../components/ui/input";
import { Switch } from "../../components/ui/switch";
import { Select } from "../../components/ui/select";
import { PasswordModal } from "../../components/shared";

interface RuntimeSettings {
  proxyAuthMode: "open" | "api_key";
  privacyMode: "masked" | "full";
  trackPayloads: "none" | "bounded";
  trackAssets: "none" | "meta";
  maxFlightsPerIp: number;
  trustProxy: boolean;
  sessionTtlHours: number;
}

/**
 * The backend persists `runtime` as whatever subset of fields has been
 * explicitly patched — it starts as `{}` and never backfills defaults
 * (see `createSettingsService.get` in `src/console/services/console-settings.ts`).
 * Without this, every Select here reads `undefined` on a fresh install and
 * Radix renders its placeholder instead of the actual in-effect default.
 */
const RUNTIME_DEFAULTS: RuntimeSettings = {
  proxyAuthMode: "api_key",
  privacyMode: "masked",
  trackPayloads: "bounded",
  trackAssets: "meta",
  maxFlightsPerIp: 15,
  trustProxy: false,
  sessionTtlHours: 24,
};

interface SettingsResponse {
  hasPassword: boolean;
  passwordVersion: number;
  updatedAt: string;
  runtime: RuntimeSettings;
}
interface DiagnosticsResponse {
  status?: string;
  postgres?: unknown;
  telemetry?: {
    kind?: "sqlite" | "d1";
    sqlitePath?: string;
    d1Url?: string;
    // backwards compat: some builds may use `store` key
    store?: "sqlite" | "d1";
  } | null;
}
type SensitiveAction = "backup" | "restore" | null;
type DetectedBackupKind = "restore";

export function detectBackupKind(value: unknown): DetectedBackupKind | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const c = Object.fromEntries(Object.entries(value));
  return c.app === "ohmyomop-router" && typeof c.tables === "object" && c.tables !== null ? "restore" : null;
}
function errorMessage(err: unknown): string {
  return getErrorMessage(err, "Request failed");
}

export function SettingsPage() {
  const queryClient = useQueryClient();
  const [action, setAction] = useState<SensitiveAction>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [backupIncludeUsage, setBackupIncludeUsage] = useState(false);
  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const [restoreKind, setRestoreKind] = useState<DetectedBackupKind | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const reloadTimerRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (reloadTimerRef.current !== null) window.clearTimeout(reloadTimerRef.current);
    },
    [],
  );
  const [maxFlightsDraft, setMaxFlightsDraft] = useState<string | null>(null);
  const [sessionTtlDraft, setSessionTtlDraft] = useState<string | null>(null);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [resetPassword, setResetPassword] = useState("");
  const [resetConfirmation, setResetConfirmation] = useState("");

  const { data } = useQuery({ queryKey: qk.settings.all, queryFn: () => apiGet<SettingsResponse>("/settings") });
  const diagnosticsQuery = useQuery({
    queryKey: ["diagnostics"] as const,
    queryFn: () => apiGet<DiagnosticsResponse>("/diagnostics"),
    staleTime: 30_000,
  });
  const patchMutation = useMutation({
    mutationFn: (patch: Partial<RuntimeSettings>) => apiPatch<SettingsResponse>("/settings", { runtime: patch }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: qk.settings.all }),
    onError: (err) => toast.error(errorMessage(err)),
  });
  const passwordMutation = useMutation({
    mutationFn: () => apiPost<{ ok: boolean }>("/settings/password", { currentPassword, newPassword, confirmPassword }),
    onSuccess: () => {
      toast.success("Password changed — you have been signed out");
      setCurrentPassword(""); setNewPassword(""); setConfirmPassword("");
      reloadTimerRef.current = window.setTimeout(() => { reloadTimerRef.current = null; window.location.reload(); }, 800);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const resetMutation = useMutation({
    mutationFn: () => apiPost<{ ok: boolean }>("/settings/reset-all", { password: resetPassword, confirmation: resetConfirmation }),
    onSuccess: () => {
      toast.success("All configuration and runtime data reset");
      setResetPassword(""); setResetConfirmation("");
      reloadTimerRef.current = window.setTimeout(() => { reloadTimerRef.current = null; window.location.reload(); }, 800);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const patch = (p: Partial<RuntimeSettings>) => patchMutation.mutate(p);
  const settings = data ? { ...RUNTIME_DEFAULTS, ...data.runtime } : undefined;
  const telemetryRaw = diagnosticsQuery.data?.telemetry ?? null;
  const telemetryKind: "sqlite" | "d1" = (telemetryRaw?.kind ?? telemetryRaw?.store) === "d1" ? "d1" : "sqlite";
  const telemetrySqlitePath = telemetryRaw?.sqlitePath?.trim() || "./data/telemetry.db";
  const telemetryD1Url = telemetryRaw?.d1Url?.trim() || "";
  const isTelemetryD1 = telemetryKind === "d1" && telemetryD1Url.length > 0;
  const handleRestoreFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    setRestoreFile(file); setRestoreKind(null);
    if (!file) return;
    try {
      const parsed = await readJsonFile(file);
      const kind = detectBackupKind(parsed);
      if (!kind) throw new Error("Unsupported backup format");
      setRestoreKind(kind); toast.success("Oh My Omop - Router backup detected");
    } catch (e) { toast.error(e instanceof Error ? e.message : "Unable to read backup file"); }
  };
  const runSensitive = async (password: string) => {
    setActionError(null);
    try {
      if (action === "backup") {
        const { blob } = await apiDownload(`/settings/backup${backupIncludeUsage ? "?includeHistory=true" : ""}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) });
        downloadBlob(`ohmyomop-router-backup-${new Date().toISOString().slice(0, 10)}.json`, blob, "application/json");
        toast.success("Backup downloaded"); setAction(null);
      } else if (action === "restore") {
        if (!restoreFile) throw new Error("Choose a backup file first");
        const backup = await readJsonFile(restoreFile);
        await apiPost<{ ok: boolean }>("/settings/restore", { password, backup });
        toast.success("Backup restored"); setAction(null); setRestoreFile(null); setRestoreKind(null); void queryClient.invalidateQueries();
      }
    } catch (err) { setActionError(err instanceof Error ? err.message : "Action failed"); }
  };
  const actionMeta: Record<Exclude<SensitiveAction, null>, { title: string; description: string }> = {
    backup: { title: "Download backup", description: "Export settings, keys, combos, pools, access rules and accounts. Usage history is excluded by default (large)." },
    restore: { title: "Restore backup", description: `Replace the current configuration with "${restoreFile?.name ?? "the selected file"}". This overwrites settings, keys and accounts.` },
  };
  const updatedLabel = data ? new Intl.DateTimeFormat(undefined, { dateStyle: "long", timeStyle: "short" }).format(new Date(data.updatedAt)) : undefined;

  return (
    <div className="dashboard-page space-y-4">
      {/* Hero — reusable Card */}
      <Card density="comfortable" surface="elevated">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardHeader title="Settings" sub="Everything in one place — security, privacy, limits and data. Changes apply instantly." icon={Shield} />
            <p className="mt-1 hidden text-[11px] text-[var(--text-3)] sm:block">No save button needed — edits are live.</p>
          </div>
          {data && (
            <div className="flex flex-col items-start gap-1.5 sm:items-end">
              <Badge tone="ok">
                <Shield size={11} className="mr-1" aria-hidden={true} /> argon2id · v{data.passwordVersion}
              </Badge>
              <span className="text-[11px] text-[var(--text-3)]">{updatedLabel}</span>
            </div>
          )}
        </div>

        {/* Telemetry store — merged here instead of a separate card further down;
            it's read-only/env-driven, so it reads as page metadata, not a setting. */}
        <div className="mt-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-[var(--inner-border)] pt-3">
          <div className="flex min-w-0 items-center gap-2">
            <HardDrive size={13} className="shrink-0 text-[var(--text-3)]" aria-hidden={true} />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[11.5px] font-semibold text-[var(--text-1)]">Telemetry store</span>
                <Badge tone={isTelemetryD1 ? "info" : "default"}>{isTelemetryD1 ? "D1" : "SQLite"}</Badge>
              </div>
              <div className="truncate text-[11px] text-[var(--text-3)]">
                {diagnosticsQuery.isLoading ? (
                  "Loading…"
                ) : diagnosticsQuery.isError ? (
                  "Unable to load diagnostics — showing default."
                ) : isTelemetryD1 ? (
                  <>
                    via <code className="font-mono text-[10.5px]">TELEMETRY_D1_URL</code>{" "}
                    <span className="text-[var(--text-2)]" title={telemetryD1Url}>{telemetryD1Url}</span>
                  </>
                ) : (
                  <>
                    via <code className="font-mono text-[10.5px]">SQLITE_PATH</code>{" "}
                    <span className="font-mono text-[var(--text-2)]" title={telemetrySqlitePath}>{telemetrySqlitePath}</span>
                  </>
                )}
              </div>
            </div>
          </div>
          <span className="shrink-0 text-[10px] text-[var(--text-3)]">Env-driven — restart required to change</span>
        </div>
      </Card>

      {/* Security */}
      <Card density="comfortable" surface="elevated">
        <CardHeader title="Security" sub="Change console password. You’ll be signed out automatically." icon={Lock} />
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <Label htmlFor="current-password">Current password</Label>
            <Input id="current-password" name="current-password" type="password" autoComplete="current-password" placeholder="Current password…" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="new-password">New password</Label>
            <Input id="new-password" name="new-password" type="password" autoComplete="new-password" placeholder="At least 5 characters…" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="confirm-password">Confirm password</Label>
            <Input id="confirm-password" name="confirm-password" type="password" autoComplete="new-password" placeholder="Repeat new password…" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} />
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <p className="text-[11px] text-[var(--text-3)]" aria-live="polite">
            {newPassword.length > 0 && newPassword.length < 5 ? "At least 5 characters." : newPassword && newPassword !== confirmPassword ? "Passwords don’t match." : "Use a strong, unique password."}
          </p>
          <Button size="sm" disabled={!currentPassword || newPassword.length < 5 || newPassword !== confirmPassword || passwordMutation.isPending} onClick={() => passwordMutation.mutate()}>
            <KeyRound size={13} aria-hidden={true} /> {passwordMutation.isPending ? "Changing…" : "Change password"}
          </Button>
        </div>
      </Card>

      {/* Privacy + Limits — reusable bento with Card */}
      {settings && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card density="comfortable" surface="elevated" className="flex h-full flex-col">
            <CardHeader title="Privacy" sub="Control what gets stored." icon={Eye} />
            <div className="space-y-3">
              <div>
                <Label>Privacy mode</Label>
                <Select ariaLabel="Privacy mode" value={settings.privacyMode} onChange={(v) => patch({ privacyMode: v as RuntimeSettings["privacyMode"] })} options={[{ value: "masked", label: "Masked IP — recommended" }, { value: "full", label: "Show full IP" }]} className="mt-1 h-10 w-full" />
              </div>
              <div>
                <Label>Payload capture</Label>
                <Select ariaLabel="Request payload capture" value={settings.trackPayloads} onChange={(v) => patch({ trackPayloads: v as RuntimeSettings["trackPayloads"] })} options={[{ value: "bounded", label: "Bounded — 16 KiB / artifact" }, { value: "none", label: "Disabled" }]} className="mt-1 h-10 w-full" />
              </div>
              <div>
                <Label>Assets</Label>
                <Select ariaLabel="Request assets" value={settings.trackAssets} onChange={(v) => patch({ trackAssets: v as RuntimeSettings["trackAssets"] })} options={[{ value: "meta", label: "Metadata only" }, { value: "none", label: "No asset metadata" }]} className="mt-1 h-10 w-full" />
              </div>
              <p className="rounded-xl border border-[var(--inner-border)] bg-[var(--surface-1)] px-3 py-2 text-[11px] leading-4 text-[var(--text-2)]">Bounded capture ≤ 16&nbsp;KiB per artifact. Secrets are redacted before save.</p>
            </div>
          </Card>

          <Card density="comfortable" surface="elevated" className="flex h-full flex-col">
            <CardHeader title="Limits & proxy" sub="Tune concurrency and sessions." icon={SlidersHorizontal} />
            <div className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <Label htmlFor="max-flights">Max per IP</Label>
                  <Input id="max-flights" name="max-flights" type="number" inputMode="numeric" min={1} placeholder="15…" autoComplete="off" spellCheck={false} value={maxFlightsDraft ?? String(settings.maxFlightsPerIp)} onFocus={() => setMaxFlightsDraft(String(settings.maxFlightsPerIp))} onChange={(e) => setMaxFlightsDraft(e.target.value)} onBlur={() => { const next = Math.max(1, Math.floor(Number(maxFlightsDraft) || 15)); setMaxFlightsDraft(String(next)); patch({ maxFlightsPerIp: next }); }} />
                  <p className="mt-1 text-[10px] text-[var(--text-3)]">Default 15</p>
                </div>
                <div>
                  <Label htmlFor="session-ttl">Session TTL</Label>
                  <Input id="session-ttl" name="session-ttl" type="number" inputMode="numeric" min={1} max={720} placeholder="24…" autoComplete="off" spellCheck={false} value={sessionTtlDraft ?? String(settings.sessionTtlHours)} onFocus={() => setSessionTtlDraft(String(settings.sessionTtlHours))} onChange={(e) => setSessionTtlDraft(e.target.value)} onBlur={() => { const next = Math.min(720, Math.max(1, Math.floor(Number(sessionTtlDraft) || 1))); setSessionTtlDraft(String(next)); patch({ sessionTtlHours: next }); }} />
                  <p className="mt-1 text-[10px] text-[var(--text-3)]">Hours — max 720</p>
                </div>
              </div>
              <label className="flex cursor-pointer items-center justify-between gap-3 rounded-xl border border-[var(--inner-border)] bg-[var(--surface-1)] px-3 py-3">
                <span className="min-w-0">
                  <span className="block text-[12.5px] font-semibold">Trust proxy</span>
                  <span className="block text-[11px] text-[var(--text-3)]">Use X-Forwarded-For</span>
                </span>
                <Switch checked={settings.trustProxy} onChange={(v) => patch({ trustProxy: v })} label="Trust proxy" />
              </label>
            </div>
          </Card>
        </div>
      )}

      {/* Data — reusable */}
      <div className="grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
        <Card density="comfortable" surface="elevated" className="flex h-full flex-col">
          <CardHeader title="Backup & restore" sub="Export or restore your configuration as a portable JSON file — disk assets excluded." icon={Database} />
          <div className="flex flex-1 flex-col gap-3">
            {/* Backup */}
            <div className="flex flex-col gap-3 rounded-[var(--radius-control)] border border-[var(--inner-border)] bg-[var(--hover)] p-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <div className="text-xs font-semibold text-[var(--text-1)]">Download backup</div>
                <div className="mt-0.5 text-[11px] leading-relaxed text-[var(--text-3)]">
                  Settings, API keys, aliases, combos, access rules, routing and accounts.
                </div>
              </div>
              <Button variant="secondary" size="sm" className="shrink-0" onClick={() => setAction("backup")}>
                <Download size={13} aria-hidden={true} /> Download
              </Button>
            </div>

            {/* Restore */}
            <div className="flex flex-col gap-3 rounded-[var(--radius-control)] border border-[var(--inner-border)] bg-[var(--hover)] p-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 flex-1">
                <div className="text-xs font-semibold text-[var(--text-1)]">Restore from file</div>
                {restoreFile ? (
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    <FileJson size={12} className="shrink-0 text-[var(--accent)]" aria-hidden={true} />
                    <span className="min-w-0 truncate text-[11px] text-[var(--text-2)]" title={restoreFile.name}>{restoreFile.name}</span>
                    <Badge tone={restoreKind ? "ok" : "warn"} className="shrink-0">{restoreKind ? "Ready" : "Checking…"}</Badge>
                  </div>
                ) : (
                  <div className="mt-0.5 text-[11px] leading-relaxed text-[var(--text-3)]">Overwrites current settings, keys and accounts.</div>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <input ref={fileInputRef} type="file" accept="application/json,.json" className="sr-only" aria-hidden={true} tabIndex={-1} onChange={(e) => void handleRestoreFileChange(e)} />
                <Button variant="secondary" size="sm" onClick={() => fileInputRef.current?.click()}>
                  <Upload size={13} aria-hidden={true} /> {restoreFile ? "Change" : "Choose file"}
                </Button>
                <Button size="sm" disabled={!restoreKind} onClick={() => setAction("restore")}>
                  <FileJson size={13} aria-hidden={true} /> Import
                </Button>
              </div>
            </div>
          </div>
        </Card>

        <Card density="comfortable" surface="frame" className="border-[color-mix(in_srgb,var(--red)_22%,var(--inner-border))] bg-[color-mix(in_srgb,var(--red)_6%,var(--surface-1))]">
          <CardHeader title="Danger zone" sub="Wipe everything — cannot be undone." icon={AlertTriangle} iconColor="var(--red)" />
          <div className="space-y-3">
            <div>
              <Label htmlFor="reset-password">Password</Label>
              <Input id="reset-password" name="reset-password" type="password" value={resetPassword} onChange={(e) => setResetPassword(e.target.value)} placeholder="Current console password…" autoComplete="current-password" />
            </div>
            <div>
              <Label htmlFor="reset-confirm">
                Type <code className="font-mono text-[10px] text-[var(--red)]" translate="no">RESET ALL DATABASE AND RUNTIME</code>
              </Label>
              <Input id="reset-confirm" name="reset-confirm" value={resetConfirmation} onChange={(e) => setResetConfirmation(e.target.value)} placeholder="Type the confirmation text…" spellCheck={false} autoComplete="off" />
            </div>
            <Button variant="danger" className="h-10 w-full" disabled={resetMutation.isPending || resetPassword.length === 0 || resetConfirmation !== "RESET ALL DATABASE AND RUNTIME"} onClick={() => resetMutation.mutate()}>
              <Trash2 size={13} aria-hidden={true} /> {resetMutation.isPending ? "Resetting…" : "Reset all data"}
            </Button>
          </div>
        </Card>
      </div>

      <PasswordModal open={action !== null} onClose={() => { setAction(null); setActionError(null); }} onSubmit={(p) => void runSensitive(p)} title={action ? actionMeta[action].title : ""} description={action ? actionMeta[action].description : ""} error={actionError}>
        {action === "backup" && (
          <label htmlFor="include-history" className="mb-3 flex cursor-pointer items-center gap-2 text-xs text-[var(--text-2)]">
            <input id="include-history" type="checkbox" className="h-3.5 w-3.5 accent-[var(--accent)]" checked={backupIncludeUsage} onChange={(e) => setBackupIncludeUsage(e.target.checked)} />
            Include usage history — large
          </label>
        )}
      </PasswordModal>
    </div>
  );
}
