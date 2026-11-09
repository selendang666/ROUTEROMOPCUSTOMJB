/** Providers page — registry list grouped by credential kind (REQ-11). */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckSquare, ChevronRight, Plus, Square, Trash2 } from "lucide-react";
import { HeaderPairsEditor, pairsToHeaders, type HeaderPair } from "../../components/header-pairs-editor";
import { memo, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "../../lib/toast";
import { apiGet, apiPost, apiDelete } from "../../lib/api";
import { qk } from "../../lib/query-keys";
import { StatusDot } from "../../components/status-dot";
import { ProviderIcon } from "../../components/provider-icon";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { StatePanel } from "../../components/ui/state";
import { Dialog } from "../../components/ui/dialog";
import { Input, Label } from "../../components/ui/input";
import { Switch } from "../../components/ui/switch";
import { ConfirmDialog } from "../../components/shared";
import { useProviders } from "../../components/model-picker";

interface ProviderInfo {
  id: string;
  name: string;
  icon: string;
  authKind: "none" | "session" | "oauth" | "api-key";
  prefix: string;
  modelCount: number;
  capabilityCounts: {
    chat: number;
    media: number;
    websearch: number;
  };
  status: "ok" | "warn";
  connections: number;
  supportsOAuth: boolean;
  supportsApiKey: boolean;
}

const FOUNDING_IDS = new Set(["inferhub"]);
const FREE_AVAILABLE_IDS = new Set(["cerebras", "qoder", "agentrouter", "mistral", "gemini", "openrouter", "ollama", "siliconflow", "cb", "cbcn", "groq", "nvidia", "hermes", "opencodezen", "tokenharbor", "bai", "gmi", "aihubmix", "alibaba", "cloudflare", "alibabacp"]);

/** Display order: founding sponsors → free limited → OAuth → free available API key → API key */
const SECTIONS: { title: string; subtitle?: string; filter: (p: ProviderInfo) => boolean }[] = [
  { title: "Founding Friend & Sponsors", subtitle: "Super Cheap inference pool", filter: (p) => FOUNDING_IDS.has(p.id) },
  { title: "Free Limited Providers", filter: (p) => p.authKind === "none" && !FOUNDING_IDS.has(p.id) },
  { title: "OAuth Providers", filter: (p) => p.authKind === "session" || p.authKind === "oauth" || p.supportsOAuth },
  { title: "Free Available API Key Providers", subtitle: "Free tier friendly — no credit card", filter: (p) => p.authKind === "api-key" && FREE_AVAILABLE_IDS.has(p.id) && !p.supportsOAuth },
  { title: "API Key Providers", filter: (p) => p.authKind === "api-key" && !FOUNDING_IDS.has(p.id) && !FREE_AVAILABLE_IDS.has(p.id) && !p.supportsOAuth },
];

// ── Custom Providers (OpenAI/Anthropic Compatible) ──────────────────────

interface CustomProviderRecord {
  id: string;
  slug: string;
  name: string;
  kind: "openai" | "anthropic" | "openai-compatible";
  baseUrl: string;
  credentialHint: string;
  timeoutSeconds: number;
  autoFetchModels: boolean;
  customHeaders: Record<string, string>;
}

const COMPAT_DEFAULTS: Record<"openai-compatible" | "anthropic-compatible", { namePh: string; prefixPh: string }> = {
  "openai-compatible": { namePh: "OpenAI Compatible (Prod)", prefixPh: "oc-prod" },
  "anthropic-compatible": { namePh: "Anthropic Compatible (Prod)", prefixPh: "ac-prod" },
};

const DEFAULT_TIMEOUT_SECONDS = 30;

function AddCompatibleDialog({ variant, open, onClose, onCreated }: { variant: "openai-compatible" | "anthropic-compatible"; open: boolean; onClose: () => void; onCreated: () => void }) {
  const cfg = COMPAT_DEFAULTS[variant];
  const [name, setName] = useState("");
  const [prefix, setPrefix] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [credential, setCredential] = useState("");
  const [autoFetchModels, setAutoFetchModels] = useState(false);
  const [timeoutSeconds, setTimeoutSeconds] = useState(DEFAULT_TIMEOUT_SECONDS);
  const [headerPairs, setHeaderPairs] = useState<HeaderPair[]>([]);
  const [submitting, setSubmitting] = useState(false);

  const reset = () => { setName(""); setPrefix(""); setBaseUrl(""); setCredential(""); setAutoFetchModels(false); setTimeoutSeconds(DEFAULT_TIMEOUT_SECONDS); setHeaderPairs([]); };

  useEffect(() => { if (open) reset(); }, [open]);

  async function handlePaste() {
    try {
      const text = await navigator.clipboard.readText();
      if (text.trim()) setBaseUrl(text.trim());
    } catch {
      toast.error("Clipboard access denied — paste manually instead.");
    }
  }

  async function handleCredentialPaste() {
    try {
      const text = await navigator.clipboard.readText();
      if (text.trim()) setCredential(text.trim());
    } catch {
      toast.error("Clipboard access denied — paste manually instead.");
    }
  }

  async function handleCreate() {
    setSubmitting(true);
    try {
      await apiPost("/providers", { name: name.trim(), kind: variant === "anthropic-compatible" ? "anthropic" : "openai-compatible", baseUrl: baseUrl.trim(), credential: credential.trim(), slug: prefix.trim(), timeoutSeconds, autoFetchModels, customHeaders: pairsToHeaders(headerPairs) });
      onCreated();
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Create failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={variant === "openai-compatible" ? "Add OpenAI Compatible" : "Add Anthropic Compatible"}
      footer={
        <>
          <Button onClick={handleCreate} disabled={!name.trim() || !prefix.trim() || !baseUrl.trim() || !credential.trim() || submitting}>{submitting ? "Creating…" : "Create"}</Button>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
        </>
      }
    >
      <div className="space-y-3">
        <div>
          <Label>Required. A friendly label for this node.</Label>
          <Input placeholder={cfg.namePh} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <Label>Required. Used as the provider prefix for model IDs.</Label>
          <Input placeholder={cfg.prefixPh} value={prefix} onChange={(e) => setPrefix(e.target.value)} />
        </div>
        <div>
          <Label>Base URL</Label>
          <div className="flex gap-2">
            <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} className="min-w-0 flex-1" />
            <Button type="button" variant="secondary" onClick={handlePaste}>Paste</Button>
          </div>
        </div>
        <div>
          <Label>API Keys — one per line, multiple keys will create multiple accounts for load balancing.</Label>
          <div className="flex gap-2">
            <textarea
              value={credential}
              onChange={(e) => setCredential(e.target.value)}
              className="min-h-24 min-w-0 flex-1 rounded-xl border border-[var(--inner-border)] bg-[var(--input-bg)] p-3 font-mono text-xs text-[var(--text-1)] outline-none placeholder:text-[var(--text-3)]"
              placeholder={"sk-...\nsk-... (one per line)"}
              spellCheck={false}
            />
            <Button type="button" variant="secondary" onClick={handleCredentialPaste} className="self-start">Paste</Button>
          </div>
          <p className="mt-1 text-[11px] text-[var(--text-3)]">{credential.split(/\r?\n/).filter((value) => value.trim()).length} key(s) will be created. Keys are validated on save and can be tested via model test in detail.</p>
        </div>
        <div className="flex items-end gap-2">
          <div className="min-w-0 flex-1">
            <Label>Timeout (seconds)</Label>
            <Input
              type="number"
              min={1}
              max={300}
              value={timeoutSeconds}
              onChange={(e) => setTimeoutSeconds(Math.min(300, Math.max(1, Number(e.target.value) || DEFAULT_TIMEOUT_SECONDS)))}
            />
          </div>
          <label className="flex h-10 shrink-0 cursor-pointer items-center gap-2 rounded-lg border border-[var(--inner-border)] bg-[var(--surface-muted)] px-3 text-sm text-[var(--text-2)]">
            <Switch checked={autoFetchModels} onChange={setAutoFetchModels} label="Auto-fetch models" />
            Auto-fetch models
          </label>
        </div>
        <HeaderPairsEditor pairs={headerPairs} onChange={setHeaderPairs} />
      </div>
    </Dialog>
  );
}

function CustomProvidersSection() {
  const qc = useQueryClient();
  const { data, isPending, isError } = useQuery({
    queryKey: qk.providers.customAll,
    queryFn: async () => {
      const response = await apiGet<{ items: CustomProviderRecord[] }>("/providers");
      const filtered = response.items.filter((provider) => {
        if (provider === null || typeof provider !== "object") return false;
        if (!("slug" in provider) || !("baseUrl" in provider)) return false;
        const slug = provider.slug;
        const baseUrl = provider.baseUrl;
        return typeof slug === "string" && typeof baseUrl === "string";
      });
      return { items: filtered };
    },
  });
  const [showOpenAI, setShowOpenAI] = useState(false);
  const [showAnthropic, setShowAnthropic] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<CustomProviderRecord | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: qk.providers.all });
    void qc.invalidateQueries({ queryKey: qk.providers.customAll });
  };

  const deleteMut = useMutation({
    mutationFn: (id: string) => apiDelete<{ ok: boolean }>(`/providers/${id}`),
    onSuccess: () => { invalidate(); setDeleteTarget(null); toast.success("Custom provider deleted"); },
    onError: (e: Error) => toast.error(e.message),
  });

  const items = data?.items ?? [];
  const allSelected = items.length > 0 && items.every((item) => selectedIds.has(item.id));
  const toggleSelected = (id: string) => setSelectedIds((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const toggleAll = () => setSelectedIds(allSelected ? new Set() : new Set(items.map((item) => item.id)));

  const bulkDeleteMut = useMutation({
    mutationFn: async (ids: string[]) => { await Promise.all(ids.map((id) => apiDelete<{ ok: boolean }>(`/providers/${id}`))); },
    onSuccess: () => { setSelectedIds(new Set()); invalidate(); toast.success("Selected providers deleted"); },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <section className="space-y-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="text-sm font-semibold tracking-tight">Custom Providers</h2>
        <div className="grid w-full grid-cols-2 gap-2 sm:w-auto sm:min-w-[230px]">
          <Button size="sm" className="w-full justify-center" title="Add custom Anthropic-compatible provider" aria-label="Add custom Anthropic-compatible provider" onClick={() => setShowAnthropic(true)}>
            <Plus size={13} /> <span>Custom Anthropic</span>
          </Button>
          <Button size="sm" className="w-full justify-center" title="Add custom OpenAI-compatible provider" aria-label="Add custom OpenAI-compatible provider" onClick={() => setShowOpenAI(true)}>
            <Plus size={13} /> <span>Custom OpenAI</span>
          </Button>
        </div>
      </div>
      {items.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--inner-border)] bg-[var(--hover)] px-2.5 py-2">
          <button type="button" className="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--text-2)] hover:text-[var(--text-1)]" onClick={toggleAll}>
            {allSelected ? <CheckSquare size={15} /> : <Square size={15} />}
            {allSelected ? "Clear selection" : "Select all"}
          </button>
          {selectedIds.size > 0 && (
            <Button variant="danger" size="sm" disabled={bulkDeleteMut.isPending} onClick={() => setDeleteTarget({ id: "__bulk__", name: `${selectedIds.size} selected providers`, slug: "", kind: "openai-compatible", baseUrl: "", credentialHint: "", timeoutSeconds: 0, autoFetchModels: false, customHeaders: {} })}>
              <Trash2 size={13} /> Delete selected ({selectedIds.size})
            </Button>
          )}
        </div>
      )}
      {isPending ? (
        <div className="rounded-xl border border-[var(--inner-border)] bg-[var(--glass-bg-2)]/60 p-4 backdrop-blur-xl">
          <div className="h-10 animate-pulse rounded-lg bg-[var(--surface-muted)]" aria-label="Loading custom providers" />
        </div>
      ) : isError ? (
        <div className="rounded-xl border border-[var(--red)]/25 bg-[var(--glass-bg-2)]/70 p-4 text-sm text-[var(--text-2)] backdrop-blur-xl">
          Could not load custom providers. Retry the page to check your saved endpoints again.
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[var(--inner-border)] bg-[var(--glass-bg-2)]/60 px-4 py-7 text-center backdrop-blur-xl">
          <p className="text-sm font-semibold text-[var(--text-1)]">No custom providers yet</p>
          <p className="mt-1 text-xs leading-5 text-[var(--text-2)]">Add an OpenAI- or Anthropic-compatible endpoint with the buttons above.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {items.map((cp) => {
            return (
              <Card key={cp.id} className="group relative overflow-hidden p-3 transition-transform duration-150 hover:-translate-y-0.5 hover:shadow-lg">
                <button type="button" title={`Select ${cp.name}`} aria-label={`Select ${cp.name}`} className="absolute left-2 top-2 z-10 hidden shrink-0 text-[var(--text-3)] hover:text-[var(--accent)] group-hover:block data-[selected=true]:block" data-selected={selectedIds.has(cp.id)} onClick={() => toggleSelected(cp.id)}>
                  {selectedIds.has(cp.id) ? <CheckSquare size={15} className="text-[var(--accent)]" /> : <Square size={15} />}
                </button>
                <Link to={`/providers/custom/${cp.id}`} className="block rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]">
                  <div className="flex items-center gap-2.5">
                    <ProviderIcon icon={cp.slug} name={cp.name} size={32} />
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-sm font-semibold">{cp.name}</span>
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        <Badge tone="ok" className="gap-1.5">
                          <StatusDot status="ok" />
                          Configured
                        </Badge>
                      </div>
                    </div>
                    <div className="ml-auto flex shrink-0 flex-col items-end gap-1">
                      <span className="rounded-md bg-[var(--kbd-bg)] px-1.5 py-0.5 font-mono text-[10px] font-semibold text-[var(--text-3)]">{cp.slug}/</span>
                      <Badge tone="info">Custom</Badge>
                    </div>
                  </div>
                </Link>
                <div className="absolute right-1 top-1 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                  <Button variant="ghost" size="icon" title={`Delete ${cp.name}`} aria-label={`Delete ${cp.name}`} onClick={() => setDeleteTarget(cp)} className="size-7">
                    <Trash2 size={13} />
                  </Button>
                  <Link to={`/providers/custom/${cp.id}`} className="grid size-7 place-items-center text-[var(--text-3)] hover:text-[var(--text-1)]">
                    <ChevronRight size={14} />
                  </Link>
                </div>
              </Card>
            );
          })}
        </div>
      )}
      <AddCompatibleDialog variant="openai-compatible" open={showOpenAI} onClose={() => setShowOpenAI(false)} onCreated={invalidate} />
      <AddCompatibleDialog variant="anthropic-compatible" open={showAnthropic} onClose={() => setShowAnthropic(false)} onCreated={invalidate} />
      <ConfirmDialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (deleteTarget?.id === "__bulk__") bulkDeleteMut.mutate([...selectedIds]);
          else if (deleteTarget) deleteMut.mutate(deleteTarget.id);
          setDeleteTarget(null);
        }}
        title={deleteTarget?.id === "__bulk__" ? "Delete selected providers?" : "Delete custom provider?"}
        message={deleteTarget?.id === "__bulk__" ? `Remove ${selectedIds.size} selected providers? Their routes will stop working.` : `Remove provider "${deleteTarget?.name}" (${deleteTarget?.slug})? Requests to ${deleteTarget?.slug}/... will no longer route.`}
        confirmLabel="Delete"
        danger
      />
    </section>
  );
}

/** Credential state shown under the provider name. */
function StatusLine({ provider }: { provider: ProviderInfo }) {
  if (provider.authKind === "none") return <Badge tone="ok">Ready</Badge>;
  if (provider.connections === 0) return <Badge>No connections</Badge>;
  return (
    <Badge tone="ok" className="gap-1.5">
      <StatusDot status="ok" />
      {provider.connections} Connected
    </Badge>
  );
}

const ProviderCard = memo(function ProviderCard({ provider }: { provider: ProviderInfo }) {
  const isFounding = FOUNDING_IDS.has(provider.id);
  return (
    <Card className="relative overflow-hidden p-3 transition-transform duration-150 hover:-translate-y-0.5 hover:shadow-lg">
      {isFounding && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -right-10 top-4 rotate-45 bg-[var(--accent)]/65 px-10 py-0.5 text-center text-[10px] font-bold uppercase tracking-widest text-[var(--accent-foreground)] shadow-md backdrop-blur-[2px]"
        >
          Friend
        </div>
      )}
      <Link to={`/providers/${provider.id}`} className="block rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]">
        <div className="flex items-center gap-2.5">
          <ProviderIcon icon={provider.icon} name={provider.name} size={32} />
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-sm font-semibold">{provider.name}</span>
              {provider.status === "warn" && <StatusDot status="warn" />}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <StatusLine provider={provider} />

            </div>
          </div>
          <div className="ml-auto flex shrink-0 flex-col items-end gap-1">
            <span className="rounded-md bg-[var(--kbd-bg)] px-1.5 py-0.5 font-mono text-[10px] font-semibold text-[var(--text-3)]">
              {provider.prefix}/
            </span>
            <Badge tone="info">{provider.modelCount} models</Badge>
          </div>
        </div>
      </Link>

      </Card>
  );
});

export function ProvidersPage() {
  const { data, isLoading, isFetching, isError, refetch } = useProviders();
  const items: ProviderInfo[] = (data?.items ?? []).map((provider: { id: string; name: string; icon: string; credentialKind?: string | null; prefix: string; modelCount: number; capabilityCounts?: { chat: number; media: number; websearch: number }; enabled?: boolean; configured?: boolean; credentialKinds?: string[]; connections: number }) => ({
    id: provider.id,
    name: provider.name,
    icon: provider.icon,
    authKind: (provider.credentialKind === "api_key" ? "api-key" : provider.credentialKind === "manual" ? "none" : provider.credentialKind ?? "none") as ProviderInfo["authKind"],
    prefix: provider.prefix,
    modelCount: provider.modelCount,
    capabilityCounts: provider.capabilityCounts ?? { chat: provider.modelCount, media: 0, websearch: 0 },
    status: (provider.enabled !== false && (provider.credentialKind === "manual" || provider.credentialKind === "none" || provider.configured === true) ? "ok" : "warn") as ProviderInfo["status"],
    connections: provider.connections,
    supportsOAuth: provider.credentialKinds?.includes("oauth") ?? provider.credentialKind === "oauth",
    supportsApiKey: provider.credentialKinds?.includes("api_key") ?? provider.credentialKind === "api_key",
  }));
  const registryLoading = isLoading || (isFetching && items.length === 0);
  // All-in-one: no capability filter, show every provider together
  const sections = SECTIONS.map((section) => ({
    ...section,
    providers: items
      .filter((provider) => section.filter(provider))
      .sort((left, right) => right.connections - left.connections || left.name.localeCompare(right.name)),
  })).filter((section) => section.providers.length > 0);

  const totalProviders = sections.reduce((total, section) => total + section.providers.length, 0);

  return (
    <div className="dashboard-page space-y-4">
      {registryLoading ? (
        <StatePanel kind="loading" title="Loading providers" description="Reading the provider registry…" />
      ) : isError && items.length === 0 ? (
        <StatePanel kind="error" title="Failed to load providers" action={<Button variant="secondary" onClick={() => refetch()}>Retry</Button>} />
      ) : (
        <div className="space-y-6">
          <CustomProvidersSection />
          {sections.length === 0 ? (
            <StatePanel kind="empty" title="No providers" description="No providers available." />
          ) : sections.map((section) => (
            <section key={section.title} className="space-y-3">
              <div className="flex flex-col gap-1">
                <h2 className="text-base font-semibold tracking-tight">{section.title} ({section.providers.length})</h2>
                {section.subtitle && <p className="text-xs text-[var(--text-2)]">{section.subtitle}</p>}
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {section.providers.map((provider) => (
                  <div key={provider.id} className="min-w-0 [contain-intrinsic-size:160px] [content-visibility:auto]">
                    <ProviderCard provider={provider} />
                  </div>
                ))}
              </div>
            </section>
          ))}
          {totalProviders > 0 && <div className="flex min-h-10 items-center justify-center rounded-xl border border-[var(--inner-border)] bg-[var(--glass-bg-2)]/55 px-4 py-2 text-center text-[11px] text-[var(--text-3)] backdrop-blur-xl">Showing all {totalProviders} providers</div>}
        </div>
      )}
    </div>
  );
}
