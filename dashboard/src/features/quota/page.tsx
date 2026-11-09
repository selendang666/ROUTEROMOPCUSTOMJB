import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Clock3, EyeOff, Loader2, RefreshCw, RotateCcw, SlidersHorizontal, Trash2, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Switch } from "../../components/ui/switch";
import { Button } from "../../components/ui/button";
import { StatePanel } from "../../components/ui/state";
import { ProviderIcon } from "../../components/provider-icon";
import { ConfirmDialog } from "../../components/shared";
import { Select } from "../../components/ui/select";
import { apiDelete, apiGet, apiPatch, apiPost } from "../../lib/api";
import { getErrorMessage } from "../../lib/helpers.js";
import { cn } from "../../lib/cn";
import { toast } from "../../lib/toast";
import { qk } from "../../lib/query-keys";
import { friendlyQuotaError, formatQuotaRefresh, formatQuotaWindowLabel, formatResetDistance, quotaBarTone } from "./formatters";
import { accountIdentity } from "../providers/formatters";

/** Providers that have a real quota endpoint in fetchProviderQuota. */
const QUOTA_SUPPORTED_PROVIDERS: ReadonlySet<string> = new Set(["cline", "codex", "claude-code", "antigravity", "ollama", "cursor", "devin", "zai", "zai-coding-plan", "kimi-code", "github-copilot"]);

interface ProviderSummary { id: string; name: string; authKind?: string; icon?: string; }
interface QuotaWindow { kind?: string; label: string; remainingPercent: number | null; usedPercent?: number | null; resetsAt: string | null; used?: number | null; limit?: number | null; }
interface QuotaData { source: string | null; status: "unknown" | "refreshing" | "ready" | "error"; plan: string | null; windows: QuotaWindow[]; fetchedAt: string | null; lastAttemptAt: string | null; lastSuccessAt: string | null; error: string | null; }
interface AccountHealth { status: string; statusCode?: number | null; sanitizedMessage?: string | null; retryAt?: string | null; }
interface AccountResponse { id: string; providerId?: string; provider?: string; name?: string; credentialHint?: string; active?: boolean; quota?: unknown; health?: unknown; }
interface Account extends Omit<AccountResponse, "name" | "credentialHint" | "active" | "quota" | "health"> { provider: string; name: string; credentialHint: string; active: boolean; quota: QuotaData | null; health: AccountHealth | null; }
interface QuotaEntry extends Account { providerName: string; providerIcon: string; }
interface QuotaQueryData { providers: ProviderSummary[]; accounts: QuotaEntry[]; }

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeQuota(value: unknown): QuotaData | null {
  const raw = asRecord(value);
  if (!raw) return null;
  const status = stringValue(raw.status);
  const windows = Array.isArray(raw.windows) ? raw.windows.flatMap((entry, index) => {
    const window = asRecord(entry);
    if (!window) return [];
    return [{ kind: stringValue(window.kind) ?? undefined, label: stringValue(window.label) ?? `Window ${index + 1}`, remainingPercent: numberValue(window.remainingPercent), usedPercent: numberValue(window.usedPercent), resetsAt: stringValue(window.resetsAt), used: numberValue(window.used), limit: numberValue(window.limit) }];
  }) : [];
  return { source: stringValue(raw.source), status: status === "refreshing" || status === "ready" || status === "error" ? status : "unknown", plan: stringValue(raw.plan), windows, fetchedAt: stringValue(raw.fetchedAt), lastAttemptAt: stringValue(raw.lastAttemptAt), lastSuccessAt: stringValue(raw.lastSuccessAt), error: stringValue(raw.error ?? raw.sanitizedError) };
}

function normalizeHealth(value: unknown): AccountHealth | null {
  const raw = asRecord(value);
  const status = stringValue(raw?.status);
  if (!status) return null;
  return { status, statusCode: numberValue(raw?.statusCode), sanitizedMessage: stringValue(raw?.sanitizedMessage ?? raw?.error), retryAt: stringValue(raw?.retryAt) };
}

function normalizeAccount(value: unknown, provider: ProviderSummary): QuotaEntry | null {
  const raw = asRecord(value);
  const id = stringValue(raw?.id);
  if (id === null) return null;
  return {
    id,
    provider: stringValue(raw?.providerId ?? raw?.provider) ?? provider.id,
    name: stringValue(raw?.name) ?? id,
    credentialHint: stringValue(raw?.credentialHint) ?? "",
    active: raw?.active === true,
    quota: normalizeQuota(raw?.quota),
    health: normalizeHealth(raw?.health),
    providerName: provider.name,
    providerIcon: provider.icon ?? provider.id,
  };
}

function normalizeQuotaResponse(value: unknown): QuotaData | null {
  const raw = asRecord(value);
  return normalizeQuota(raw && "quota" in raw ? raw.quota : value);
}
function isEmpty(account: QuotaEntry): boolean {
  return Boolean(account.quota?.windows.length && account.quota.windows.every((window) => window.remainingPercent !== null && window.remainingPercent <= 0));
}

async function setAccountsActiveBatch(accounts: readonly QuotaEntry[], active: boolean): Promise<void> {
  const idsByProvider = new Map<string, string[]>();
  for (const account of accounts) {
    const ids = idsByProvider.get(account.provider);
    if (ids === undefined) idsByProvider.set(account.provider, [account.id]);
    else ids.push(account.id);
  }
  await Promise.all([...idsByProvider].map(([provider, ids]) => apiPatch(`/accounts/batch`, { provider, ids, active })));
}

function firstResetAt(account: QuotaEntry): number {
  const resetTimes = account.quota?.windows.map((window) => window.resetsAt ? new Date(window.resetsAt).getTime() : Number.POSITIVE_INFINITY) ?? [];
  return Math.min(...resetTimes, Number.POSITIVE_INFINITY);
}



const QUOTA_REFRESH_INTERVAL_MS = 5 * 60_000;

async function fetchQuotaAccounts(providers: ProviderSummary[]): Promise<QuotaEntry[]> {
  const accountPages = await Promise.all(providers.map(async (provider) => {
    const payload = asRecord(await apiGet<unknown>(`/accounts?provider=${encodeURIComponent(provider.id)}&limit=100`));
    const items = Array.isArray(payload?.items) ? payload.items : [];
    return items.flatMap((account) => {
      const normalized = normalizeAccount(account, provider);
      return normalized ? [normalized] : [];
    });
  }));
  return accountPages.flat();
}

async function fetchQuotaPageData(): Promise<QuotaQueryData> {
  const payload = asRecord(await apiGet<unknown>("/providers"));
  const allProviders = Array.isArray(payload?.items) ? payload.items : [];
  const providers = allProviders.flatMap((value) => {
    const raw = asRecord(value);
    const id = stringValue(raw?.id);
    if (id === null || !QUOTA_SUPPORTED_PROVIDERS.has(id)) return [];
    return [{
      id,
      name: stringValue(raw?.name ?? raw?.displayName) ?? id,
      authKind: stringValue(raw?.authKind) ?? undefined,
      icon: stringValue(raw?.icon) ?? id,
    }];
  });
  return { providers, accounts: await fetchQuotaAccounts(providers) };
}

function QuotaCard({ account, onToggle, onDelete }: { account: QuotaEntry; onToggle: (account: QuotaEntry, active: boolean) => void; onDelete: (account: QuotaEntry) => void }) {
  const queryClient = useQueryClient();
  const queryKey = qk.quota.account(account.id);
  const quotaQuery = useQuery({
    queryKey,
    queryFn: async () => normalizeQuotaResponse(await apiGet<unknown>(`/accounts/${encodeURIComponent(account.id)}/quota`)),
    initialData: account.quota?.windows.length ? account.quota : undefined,
    initialDataUpdatedAt: account.quota?.fetchedAt ? Date.parse(account.quota.fetchedAt) : undefined,
    staleTime: 2 * 60_000,
  });
  const refresh = useMutation({
    mutationFn: async () => {
      await apiPost(`/accounts/${encodeURIComponent(account.id)}/quota/refresh`);
      await queryClient.invalidateQueries({ queryKey, exact: true });
      await quotaQuery.refetch();
    },
  });
  const quota = quotaQuery.data;
  const busy = refresh.isPending || quotaQuery.isFetching;
  const rawError = refresh.error ? getErrorMessage(refresh.error, "Unable to refresh this account") : quotaQuery.error ? getErrorMessage(quotaQuery.error, "Unable to refresh this account") : quota?.error ?? account.health?.sanitizedMessage;
  const friendly = friendlyQuotaError(rawError);
  const isUnsupported = rawError ? /not available|not supported/i.test(rawError) : false;
  const cardError = isUnsupported ? null : friendly;
  const identity = accountIdentity(account.credentialHint, account.name);
  return (
    <div className="overflow-hidden rounded-2xl border border-[var(--inner-border)] bg-[var(--glass-bg)] shadow-[0_8px_30px_rgba(0,0,0,.12)] backdrop-blur-xl" aria-busy={busy}>
      {/* Header: icon + provider name + plan + account hint + actions */}
      <div className="flex items-center gap-3 px-4 py-3">
        <ProviderIcon icon={account.providerIcon} name={account.providerName} size={36} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <div className="truncate text-sm font-bold">{account.providerName}</div>
            {quota?.plan && <span className="shrink-0 rounded-full bg-[var(--accent-soft)] px-2 py-0.5 text-[10px] font-semibold text-[var(--accent)]">{quota.plan}</span>}
          </div>
          <div className="truncate text-[11px] text-[var(--text-2)]">{identity.primary}</div>
          {identity.secondary !== null && <div className="truncate text-[10px] text-[var(--text-3)]">{identity.secondary}</div>}
          {quota && <div className="truncate text-[10px] text-[var(--text-3)]">{formatQuotaRefresh(quota.lastSuccessAt ?? quota.fetchedAt)}</div>}
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" className="size-8" title="Refresh quota" aria-label={`Refresh ${account.name} quota`} disabled={busy} onClick={() => refresh.mutate()}>
            {busy ? <Loader2 size={14} className="animate-spin" /> : <RotateCcw size={14} />}
          </Button>
          <Button variant="ghost" size="icon" className="size-8 text-[var(--red)]" title="Delete account" aria-label={`Delete ${account.name}`} onClick={() => onDelete(account)}>
            <Trash2 size={14} />
          </Button>
          <Switch checked={account.active} disabled={refresh.isPending} onChange={(active) => onToggle(account, active)} label={`${account.active ? "Disable" : "Enable"} ${account.name}`} />
        </div>
      </div>

      {cardError && (
        <div className="flex items-center justify-center gap-2 border-t border-[var(--inner-border)] px-4 py-3 text-center text-[11px] text-[var(--red)]" role="alert">
          <TriangleAlert size={13} className="shrink-0" />
          <span>{cardError}</span>
        </div>
      )}

      {/* Quota progress bars */}
      {quota?.windows.length ? (
        <div className="space-y-3 border-t border-[var(--inner-border)] px-4 py-3">
          {quota.windows.map((window, index) => {
            const remaining = window.remainingPercent ?? null;
            const limit = window.limit ?? null;
            const colors = quotaBarTone(remaining);
            const quotaFillPct = remaining !== null ? Math.max(0, Math.min(100, remaining)) : 0;
            return (
              <div key={`${window.kind ?? window.label}:${window.resetsAt ?? "none"}:${index}`}>
                {/* Label + percentage */}
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="text-[11px] font-semibold text-[var(--text-1)]">{formatQuotaWindowLabel(window.label)}</span>
                  {remaining !== null && <span className={`text-[11px] font-bold tabular-nums ${colors.text}`}>{remaining}%</span>}
                </div>
                {/* Pill progress bar */}
                <div className="h-2 overflow-hidden rounded-full bg-[var(--inner-border)]">
                  <div className={cn("h-full rounded-full transition-all duration-500", colors.bar)} style={{ width: `${quotaFillPct}%` }} />
                </div>
                {/* Used / limit + reset */}
                <div className="mt-1 flex items-center justify-between text-[10px] text-[var(--text-3)]">
                  {(window.usedPercent !== null || limit !== null) && <span className="tabular-nums">{window.usedPercent !== null ? `${window.usedPercent}% used` : ""}{limit !== null ? `${window.usedPercent !== null ? " · " : ""}limit ${limit.toLocaleString()}` : ""}</span>}
                  {window.resetsAt && <span className="tabular-nums">{formatResetDistance(window.resetsAt)}</span>}
                </div>
              </div>
            );
          })}
        </div>
      ) : !cardError ? (
        <div className="border-t border-[var(--inner-border)] py-6 text-center text-[11px] text-[var(--text-3)]">
          {busy ? "Loading…" : "No quota data"}
        </div>
      ) : null}

    </div>
  );
}

export function QuotaPage() {
  const [providerFilter, setProviderFilter] = useState("all");
  const [accountFilter, setAccountFilter] = useState("all");
  const [expiringFirst, setExpiringFirst] = useState(false);
  const queryClient = useQueryClient();
  const { data, isLoading, isError, error, isFetching, dataUpdatedAt, refetch } = useQuery<QuotaQueryData>({
    queryKey: qk.quota.management,
    queryFn: fetchQuotaPageData,
    staleTime: 0,
    refetchInterval: QUOTA_REFRESH_INTERVAL_MS,
    refetchIntervalInBackground: false,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
  });
  const providers = data?.providers ?? [];
  const accounts = useMemo(() => data?.accounts ?? [], [data?.accounts]);
  const refreshMutation = useMutation({
    mutationFn: () => apiPost<{ ok: boolean; queued: number; active: number }>("/quota/refresh", { accountIds: accounts.map((account) => account.id) }),
    onSuccess: (result) => {
      toast.success(result.queued > 0 ? `Queued ${result.queued} quota refreshes` : "Quota refreshes are already in progress");
      setTimeout(() => {
        void queryClient.invalidateQueries({ queryKey: qk.quota.management });
      }, 1_000);
    },
    onError: (error) => toast.error(getErrorMessage(error, "Unable to refresh quota")),
  });
  const [deleteTarget, setDeleteTarget] = useState<QuotaEntry | null>(null);
  useEffect(() => {
    for (const account of accounts) queryClient.setQueryData(["console", "quota-account", account.id], account.quota);
  }, [accounts, queryClient]);
  const filteredAccounts = useMemo(() => {
    const result = accounts.filter((account) => {
      if (providerFilter !== "all" && account.provider !== providerFilter) return false;
      const hasQuota = Boolean(account.quota?.windows.length);
      if (accountFilter === "untracked") return !hasQuota;
      if (!hasQuota) return false;
      if (accountFilter === "active" && !account.active) return false;
      if (accountFilter === "disabled" && account.active) return false;
      return true;
    });
    if (!expiringFirst) return result;
    return [...result].sort((left, right) => firstResetAt(left) - firstResetAt(right));
  }, [accountFilter, accounts, expiringFirst, providerFilter]);
  const updateAccount = async (account: QuotaEntry, active: boolean) => {
    try {
      await apiPatch<{ ok: boolean }>(`/accounts/${account.id}`, { provider: account.provider, active });
      toast.success(`${account.name} ${active ? "enabled" : "disabled"}`);
      await refetch();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to update account");
    }
  };
  const turnOffEmpty = async () => {
    const targets = accounts.filter((account) => account.active && isEmpty(account));
    await setAccountsActiveBatch(targets, false);
    toast.success(`Disabled ${targets.length} empty accounts`);
    await refetch();
  };
  const turnOnAvailable = async () => {
    const targets = accounts.filter((account) => !account.active && account.quota?.windows.some((window) => window.remainingPercent !== null && window.remainingPercent > 0));
    await setAccountsActiveBatch(targets, true);
    toast.success(`Enabled ${targets.length} available accounts`);
    await refetch();
  };
  const deleteAccount = async (account: QuotaEntry) => {
    try {
      await apiDelete(`/accounts/${account.id}`);
      toast.success(`${account.name} deleted`);
      await refetch();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to delete account");
    }
  };
  const lastUpdated = dataUpdatedAt > 0 ? new Date(dataUpdatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "Not updated";
  const emptyCount = accounts.filter(isEmpty).length;

  return (
    <div className="dashboard-page flex min-h-0 flex-1 flex-col gap-4">
      <div className="flex flex-wrap items-center gap-1.5 rounded-xl border border-[var(--inner-border)] bg-[var(--surface-1)] p-2">
        <SlidersHorizontal size={14} className="mx-1 text-[var(--text-3)]" aria-hidden="true" />
        <Select ariaLabel="Filter quota by provider" value={providerFilter} onChange={setProviderFilter} options={[{ value: "all", label: "All Providers" }, ...providers.map((provider) => ({ value: provider.id, label: provider.name }))]} />
        <Select ariaLabel="Filter quota by account" value={accountFilter} onChange={setAccountFilter} options={[{ value: "all", label: "With quota" }, { value: "active", label: "Active" }, { value: "disabled", label: "Disabled" }, { value: "untracked", label: "No quota" }]} />
        <Button variant={expiringFirst ? "secondary" : "ghost"} size="sm" onClick={() => setExpiringFirst((current) => !current)}><Clock3 size={13} /> Expiring first</Button>
        <Button variant="ghost" size="sm" className="text-[var(--red)]" disabled={emptyCount === 0 || isFetching} onClick={() => void turnOffEmpty()}><EyeOff size={13} /> Turn off Empty</Button>
        <Button variant="ghost" size="sm" className="text-[var(--green)]" disabled={isFetching} onClick={() => void turnOnAvailable()}><Check size={13} /> Turn on Available</Button>
        <span className="ml-auto flex items-center gap-1 text-[10px] text-[var(--text-3)]"><span className="inline-block size-1.5 animate-pulse rounded-full bg-[var(--green)]" /> Auto-refresh every 5 minutes · updated {lastUpdated} · {filteredAccounts.length} shown</span>
        <Button variant="ghost" size="icon" className="size-8" title="Queue quota refresh" aria-label="Queue quota refresh" disabled={isFetching || refreshMutation.isPending || accounts.length === 0} onClick={() => refreshMutation.mutate()}><RefreshCw size={14} className={refreshMutation.isPending ? "animate-spin" : undefined} /></Button>
      </div>

      {isLoading ? <StatePanel className="min-h-0 flex flex-1 flex-col items-center justify-center" kind="loading" title="Loading quota data" description="Reading provider account limits…" /> : isError ? <StatePanel className="min-h-0 flex flex-1 flex-col items-center justify-center" kind="error" title="Unable to load quota data" description={getErrorMessage(error, "Check the console session and retry.")} action={<Button variant="secondary" onClick={() => void refetch()}>Retry</Button>} /> : filteredAccounts.length === 0 ? <StatePanel className="min-h-0 flex flex-1 flex-col items-center justify-center" kind="empty" title="No account quota data" description="No tracked provider quota is available yet." /> : <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">{filteredAccounts.map((account) => <QuotaCard key={account.id} account={account} onToggle={(entry, active) => void updateAccount(entry, active)} onDelete={(entry) => setDeleteTarget(entry)} />)}</div>}

      <ConfirmDialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => { if (deleteTarget) void deleteAccount(deleteTarget); }}
        title="Delete account?"
        message={`Delete "${deleteTarget?.name}"? This cannot be undone.`}
        confirmLabel="Delete"
        danger
      />
    </div>
  );
}
