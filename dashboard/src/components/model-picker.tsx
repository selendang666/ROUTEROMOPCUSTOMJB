/**
 * Shared "pick a provider / pick a model" experience — one picker instead of
 * three ad-hoc newline-separated textareas. Powers API key ACL fields
 * (allowed providers, allowed/denied models), combo model lists, and the
 * alias target field, so every surface that names a provider or model
 * behaves the same way: browse a catalog, or type one manually.
 */

import { useDeferredValue, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Boxes, Check, ChevronDown, Search, X } from "lucide-react";
import { apiGet } from "../lib/api";
import { qk } from "../lib/query-keys";
import { cn } from "../lib/cn";
import { Label } from "./ui/input";
import { Dialog } from "./ui/dialog";
import { ProviderIcon } from "./provider-icon";
import { useWindowedList } from "../hooks/use-windowed-list";
export interface ProviderSummary {
  id: string;
  name: string;
  icon: string;
  prefix: string;
  modelCount: number;
  connections: number;
  source?: "builtin" | "custom";
  models?: CatalogModel[];
  capabilityCounts?: {
    chat: number;
    media: number;
    websearch: number;
  };
  credentialKind?: "api_key" | "oauth" | "session" | "manual" | "none";
  credentialKinds?: Array<"api_key" | "oauth" | "session" | "manual" | "none">;
  enabled?: boolean;
  configured?: boolean;
}

interface CatalogModel {
  id?: string;
  modelId?: string;
  name?: string;
  enabled?: boolean;
  images?: boolean;
  capabilities?: {
    chat?: boolean;
    media?: boolean;
  };
}


export type ModelPickerCapability = "chat" | "media";

export interface ModelCapabilityFlags {
  chat: boolean;
  media: boolean;
  reasoning?: boolean;
}

export interface ComboSummary {
  name: string;
  models?: string[];
}

export interface AliasSummary {
  alias: string;
  model: string;
}

export interface FlatModelEntry {
  provider: ProviderSummary;
  qualified: string;
  capabilities: ModelCapabilityFlags;
}

interface CustomProviderCatalogEntry {
  slug: string;
  name: string;
  models: Array<{ id?: string; modelId?: string } | string>;
  credentialHint?: string;
  enabled?: boolean;
}

function isCustomProviderEntry(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return entry.source === "custom"
    || (typeof entry.slug === "string" && (typeof entry.baseUrl === "string" || Array.isArray(entry.models)));
}

/**
 * Custom OpenAI/Anthropic-compatible providers (Console → Providers →
 * Custom) live in a separate table/endpoint from the built-in registry
 * (`custom_providers`, not `provider_registry`). The list endpoint already
 * embeds each provider's discovered `models`, so no per-id detail fetch is
 * needed here the way built-in providers require.
 */
export function useCustomProviders(enabled: boolean) {
  return useQuery({
    queryKey: qk.providers.customAll,
    queryFn: async () => {
      const response = await apiGet<{ items: CustomProviderCatalogEntry[] }>("/providers");
      const filtered = response.items.filter((provider) => {
        if (provider === null || typeof provider !== "object") return false;
        if (!("slug" in provider) || !("models" in provider)) return false;
        const slug = provider.slug;
        const models = provider.models;
        return typeof slug === "string" && Array.isArray(models);
      });
      return { items: filtered };
    },
    staleTime: 60_000,
    gcTime: 60_000,
    enabled,
  });
}

/**
 * Flattens custom providers into the same `FlatModelEntry` shape built-in
 * providers use, so both sources merge into one searchable/groupable list.
 */
export function useCustomProviderCatalog(customProviders: CustomProviderCatalogEntry[]): FlatModelEntry[] {
  return useMemo(
    () =>
      customProviders.filter((provider) => provider.enabled !== false && (provider.credentialHint === undefined || provider.credentialHint.length > 0)).flatMap((provider) => {
        const summary: ProviderSummary = {
          id: `custom:${provider.slug}`,
          name: provider.name,
          icon: provider.slug,
          prefix: provider.slug,
          modelCount: provider.models.length,
          connections: 0,
        };
        return provider.models.flatMap((model) => {
          const modelId = typeof model === "string" ? model : model.id ?? model.modelId;
          if (!modelId) return [];
          const qualified = modelId.startsWith(`${provider.slug}/`) ? modelId : `${provider.slug}/${modelId}`;
          return [{ provider: summary, qualified, capabilities: { chat: true, media: false } }];
        });
      }),
    [customProviders]
  );
}

export function useProviders() {
  return useQuery({
    queryKey: qk.providers.all,
    queryFn: async () => {
      const response = await apiGet<{ items: Array<ProviderSummary & { icon?: string; prefix?: string; accountCount?: number; modelCount?: number }> } | Array<ProviderSummary & { icon?: string; prefix?: string; accountCount?: number; modelCount?: number }>>("/providers");
      const rawItems = Array.isArray(response) ? response : (response as { items?: unknown[] }).items ?? [];
      const builtinItems = rawItems.filter((provider) => !isCustomProviderEntry(provider)) as Array<ProviderSummary & { icon?: string; prefix?: string; accountCount?: number; modelCount?: number }>;
      return {
        items: builtinItems.map((provider) => ({
          ...provider,
          icon: provider.icon ?? provider.id,
          prefix: provider.prefix ?? provider.id,
          modelCount: provider.modelCount ?? 0,
          connections: (provider as unknown as Record<string, unknown>).connections as number | undefined ?? (provider as unknown as Record<string, unknown>).accountCount as number | undefined ?? 0,
        })),
      };
    },
    staleTime: 60_000,
    gcTime: 60_000,
    refetchOnWindowFocus: false,
    retry: 2,
  });
}

/** Flattens every provider's enabled models into one searchable list.
 * Catalog entries use a dedicated cache namespace so raw API responses from
 * the provider detail page cannot be mistaken for its normalized view. */
interface ModelCatalogState {
  items: FlatModelEntry[];
  isLoading: boolean;
  isError: boolean;
}

function canLoadCatalog(provider: ProviderSummary): boolean {
  return provider.credentialKind === "none" || provider.configured === true;
}
function modelCapabilityFlags(model: CatalogModel): ModelCapabilityFlags {
  const declared = model.capabilities as Record<string, unknown> | undefined;
  return {
    chat: (declared?.["chat"] as boolean | undefined) ?? true,
    media: declared?.["media"] === true,
    reasoning: declared?.["reasoning"] === true,
  };
}

export function useModelCatalogState(providers: ProviderSummary[], enabled: boolean): ModelCatalogState {
  const items = useMemo(() => {
    if (!enabled) return [];
    return providers.flatMap((provider) => {
      if (!canLoadCatalog(provider)) return [];
      return (provider.models ?? []).flatMap((model) => {
        const modelId = model.id ?? model.modelId;
        if (!modelId || model.enabled === false) return [];
        const qualified = modelId.startsWith(`${provider.prefix}/`) ? modelId : `${provider.prefix}/${modelId}`;
        return [{ provider, qualified, capabilities: modelCapabilityFlags(model) }];
      });
    });
  }, [providers, enabled]);

  return {
    items,
    isLoading: false,
    isError: false,
  };
}

export function useModelCatalog(providers: ProviderSummary[], enabled: boolean): FlatModelEntry[] {
  return useModelCatalogState(providers, enabled).items;
}

export function useCombos(enabled: boolean) {
  return useQuery({
    queryKey: qk.combos.all,
    queryFn: () => apiGet<{ items: ComboSummary[] }>("/models/combos"),
    staleTime: 60_000,
    gcTime: 60_000,
    enabled,
  });
}

/**
 * An alias resolves (bare, no provider prefix) exactly like a combo does -
 * `resolveModelChain` checks qualified prefix, then `resolveAlias(name)`,
 * then combo - so an alias's own name is a valid value anywhere a
 * `provider/model` or combo name is (API key allow/deny lists, another
 * alias's target). It was previously only addable by typing it manually;
 * this exposes it as a browsable/fetchable catalog entry too.
 */
export function useAliases(enabled: boolean) {
  return useQuery({
    queryKey: qk.aliases.all,
    queryFn: () => apiGet<{ items: AliasSummary[] }>("/models/aliases"),
    staleTime: 60_000,
    gcTime: 60_000,
    enabled,
  });
}

type PickerMode = "providers" | "models";

/**
 * Browse modal. In "providers" mode, rows are whole providers (for the
 * allowed-providers ACL). In "models" mode, rows are qualified `provider/model`
 * ids, searchable and filterable by provider, optionally alongside combo names.
 *
 * Pass `onSelectOne` for single-value pickers (alias target) — selecting a row
 * closes the modal instead of toggling membership in `selected`.
 */
/** Compact picker used by setup flows; it only exposes models from configured providers. */
export function ConfiguredModelPicker({
  value: valueProp,
  onChange,
  placeholder,
  includeCombos = false,
  includeAliases = false,
  capability,
  multiple = false,
  disabled = false,
  includeCustomProviders = true,
}: {
  value: string | string[];
  onChange: ((value: string) => void) | ((values: string[]) => void);
  placeholder?: string;
  includeCombos?: boolean;
  includeAliases?: boolean;
  capability?: ModelPickerCapability;
  includeCustomProviders?: boolean;
  multiple?: boolean;
  disabled?: boolean;
}) {
  const selectedValues = Array.isArray(valueProp) ? valueProp : [valueProp];
  const value = selectedValues[0] ?? "";
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const deferredQuery = deferredSearch.trim().toLowerCase();
  const selectedSet = useMemo(() => new Set(selectedValues), [selectedValues]);
  const providersQuery = useProviders();
  const providers = providersQuery.data?.items ?? [];
  const catalogState = useModelCatalogState(providers, open || Boolean(value));
  const customProvidersQuery = useCustomProviders(includeCustomProviders && (open || Boolean(value)));
  const customCatalog = includeCustomProviders ? useCustomProviderCatalog(customProvidersQuery.data?.items ?? []) : [];
  const combosQuery = useCombos(open && includeCombos && capability === undefined);
  const aliasesQuery = useAliases(open && includeAliases && capability === undefined);
  const catalog = useMemo(() => [...catalogState.items, ...customCatalog], [catalogState.items, customCatalog]);
  const filteredCatalog = useMemo(() => {
    if (capability === undefined) return catalog;
    return catalog.filter((entry) => {
      if (capability === "chat") return entry.capabilities.chat;
      return entry.capabilities.media;
    });
  }, [capability, catalog]);
  const flatFiltered = useMemo(() => {
    if (!deferredQuery) return filteredCatalog;
    return filteredCatalog.filter((entry) => entry.qualified.toLowerCase().includes(deferredQuery));
  }, [filteredCatalog, deferredQuery]);
  const VIRTUALIZE_THRESHOLD = 60;
  const flatWindow = useWindowedList(flatFiltered, 36, 4);
  const shouldVirtualizeFlat = flatFiltered.length > VIRTUALIZE_THRESHOLD;
  const groups = useMemo(() => {
    const source = shouldVirtualizeFlat ? (flatWindow.visibleItems as typeof flatFiltered) : flatFiltered;
    const map = new Map<string, { provider: ProviderSummary; models: FlatModelEntry[] }>();
    for (const entry of source) {
      const group = map.get(entry.provider.id);
      if (group) group.models.push(entry);
      else map.set(entry.provider.id, { provider: entry.provider, models: [entry] });
    }
    return [...map.values()];
  }, [flatFiltered, shouldVirtualizeFlat, flatWindow.visibleItems]);
  const selectValue = (nextValue: string) => {
    if (multiple) {
      const nextValues = selectedSet.has(nextValue)
        ? selectedValues.filter((selectedValue) => selectedValue !== nextValue)
        : [...selectedValues, nextValue];
      (onChange as (values: string[]) => void)(nextValues);
      return;
    }
    (onChange as (selectedValue: string) => void)(nextValue);
    setOpen(false);
  };
  const selectedProvider = providers.find((provider) => value.startsWith(`${provider.prefix}/`));
  const loading = open && (providersQuery.isPending || (includeCustomProviders && customProvidersQuery.isPending) || catalogState.isLoading || (capability === undefined && includeCombos && combosQuery.isPending) || (capability === undefined && includeAliases && aliasesQuery.isPending));
  const filteredCombos = useMemo(() => (includeCombos && capability === undefined ? (combosQuery.data?.items ?? []).filter((combo) => !deferredQuery || combo.name.toLowerCase().includes(deferredQuery)) : []), [capability, combosQuery.data, includeCombos, deferredQuery]);
  const filteredAliases = useMemo(() => (includeAliases && capability === undefined ? (aliasesQuery.data?.items ?? []).filter((alias) => !deferredQuery || alias.alias.toLowerCase().includes(deferredQuery)) : []), [capability, includeAliases, aliasesQuery.data, deferredQuery]);
  return (
    <>
      <button type="button" onClick={() => setOpen((current) => !current)} disabled={disabled} className="flex h-9 w-full min-w-0 items-center gap-2 rounded-[var(--radius-control)] border border-[var(--inner-border)] bg-[var(--hover)] px-2.5 text-left text-[11.5px] transition-colors hover:border-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50" aria-expanded={open}>
        {selectedProvider ? <ProviderIcon icon={selectedProvider.icon} name={selectedProvider.name} size={15} /> : <Boxes size={14} className="shrink-0 text-[var(--text-3)]" />}
        <span className={cn("min-w-0 flex-1 truncate font-mono", selectedValues.length === 0 && "font-sans text-[var(--text-3)]")}>{multiple ? (selectedValues.length > 0 ? `${selectedValues.length} models selected` : placeholder || "Select configured models…") : (value || placeholder || "Select configured model…")}</span>
        <ChevronDown size={12} className={cn("shrink-0 text-[var(--text-3)] transition-transform", open && "rotate-180")} />
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title={multiple ? "Select models" : "Select model"} wide>
        <div className="space-y-3">
          <div className="relative">
            <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-3)]" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  const trimmed = search.trim();
                  if (trimmed && !selectedSet.has(trimmed)) selectValue(trimmed);
                }
              }}
              placeholder="Search — type qualified id to add custom…"
              className="w-full rounded-lg border border-[var(--inner-border)] bg-[var(--surface-1)] py-2 pl-8 pr-9 text-[12px] outline-none placeholder:text-[var(--text-3)] focus:border-[var(--accent)]"
            />
            {(() => {
              const trimmed = search.trim();
              if (!trimmed || selectedSet.has(trimmed)) return null;
              const existsInCatalog = flatFiltered.some((e) => e.qualified === trimmed) || filteredAliases.some((a) => a.alias === trimmed) || filteredCombos.some((c) => c.name === trimmed);
              if (existsInCatalog) return null;
              return (
                <button type="button" onClick={() => selectValue(trimmed)} className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-md bg-[var(--accent)] px-2.5 py-1 text-[10px] font-bold text-white hover:bg-[var(--accent-hover)]">+ Add</button>
              );
            })()}
          </div>
          <div
            ref={shouldVirtualizeFlat ? (flatWindow.containerRef as React.RefObject<HTMLDivElement>) : undefined}
            onScroll={shouldVirtualizeFlat ? flatWindow.onScroll : undefined}
            className="max-h-[60vh] overflow-y-auto overscroll-contain rounded-xl border border-[var(--inner-border)] bg-[var(--hover)] p-2"
          >
            {shouldVirtualizeFlat && flatWindow.topPadding > 0 && <div style={{ height: flatWindow.topPadding }} aria-hidden="true" />}
            {loading ? (
              <div className="py-8 text-center text-[11px] text-[var(--text-3)]">Loading configured models…</div>
            ) : filteredAliases.length === 0 && filteredCombos.length === 0 && groups.length === 0 ? (
              (() => {
                const trimmed = search.trim();
                if (trimmed && !selectedSet.has(trimmed)) {
                  return (
                    <div className="py-6 text-center">
                      <p className="text-[11px] text-[var(--text-3)]">No match for "{trimmed}"</p>
                      <button type="button" onClick={() => selectValue(trimmed)} className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-[var(--accent)] bg-[var(--accent-soft)] px-3 py-1 text-[11px] font-semibold text-[var(--accent)] hover:bg-[var(--accent)] hover:text-white">+ Add "{trimmed}"</button>
                    </div>
                  );
                }
                return <div className="py-8 text-center text-[11px] text-[var(--text-3)]">No configured models match.</div>;
              })()
            ) : (
              <>
                {filteredAliases.length > 0 && (
                  <section className="mb-2.5">
                    <div className="mb-1 flex items-center gap-1.5 px-1 text-[10px] font-bold uppercase tracking-wide text-[var(--text-3)]"><Boxes size={13} /> Aliases</div>
                    <div className="model-picker-grid">
                      {filteredAliases.map((alias) => (
                        <button key={alias.alias} type="button" onClick={() => selectValue(alias.alias)} className="flex min-w-0 items-center gap-1.5 rounded-lg border border-[var(--inner-border)] bg-[var(--hover)] px-1.5 py-1.5 text-left transition-colors hover:border-[var(--accent)] hover:bg-[var(--accent-soft)]">
                          <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-[var(--accent-soft)] text-[var(--accent)]"><Boxes size={12} /></span>
                          <span className="min-w-0 flex-1 truncate font-mono text-[10px] font-semibold">{alias.alias}</span>
                          {selectedSet.has(alias.alias) && <Check size={13} className="shrink-0 text-[var(--accent)]" />}
                        </button>
                      ))}
                    </div>
                  </section>
                )}
                {filteredCombos.length > 0 && (
                  <section className="mb-2.5">
                    <div className="mb-1 flex items-center gap-1.5 px-1 text-[10px] font-bold uppercase tracking-wide text-[var(--text-3)]"><Boxes size={13} /> Combos</div>
                    <div className="model-picker-grid">
                      {filteredCombos.map((combo) => (
                        <button key={combo.name} type="button" onClick={() => selectValue(combo.name)} className="flex min-w-0 items-center gap-1.5 rounded-lg border border-[var(--inner-border)] bg-[var(--hover)] px-1.5 py-1.5 text-left transition-colors hover:border-[var(--accent)] hover:bg-[var(--accent-soft)]">
                          <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-[var(--accent-soft)] text-[var(--accent)]"><Boxes size={12} /></span>
                          <span className="min-w-0 flex-1 truncate font-mono text-[10px] font-semibold">{combo.name}</span>
                          {selectedSet.has(combo.name) && <Check size={13} className="shrink-0 text-[var(--accent)]" />}
                        </button>
                      ))}
                    </div>
                  </section>
                )}
                {groups.map(({ provider, models }) => (
                  <section key={provider.id} className="mb-2.5 last:mb-0">
                    <div className="mb-1 flex items-center gap-1.5 px-1 text-[10px] font-bold uppercase tracking-wide text-[var(--text-3)]">
                      <ProviderIcon icon={provider.icon} name={provider.name} size={13} className="rounded" />
                      <span className="truncate">{provider.name}</span>
                      <span className="ml-auto text-[9px] font-medium normal-case tracking-normal">{models.length}</span>
                    </div>
                    <div className="model-picker-grid">
                      {models.map((entry) => (
                        <button key={entry.qualified} type="button" onClick={() => selectValue(entry.qualified)} title={`Click to select — ${entry.qualified} (drag header to move, double-click text to copy)`} className={cn("group flex min-w-0 items-center gap-1.5 rounded-lg border border-[var(--inner-border)] bg-[var(--hover)] px-1.5 py-1.5 text-left transition-colors hover:border-[var(--accent)] hover:bg-[var(--accent-soft)]", selectedSet.has(entry.qualified) && "border-[var(--accent)] bg-[var(--accent-soft)]")}>
                          <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-[var(--surface-1)] text-[var(--accent)] select-none"><ProviderIcon icon={entry.provider.icon} name={entry.provider.name} size={14} className="rounded" /></span>
                          <span onDoubleClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(entry.qualified); }} className="min-w-0 flex-1 truncate select-text cursor-text font-mono text-[10px] font-semibold text-[var(--text-1)]" title={entry.qualified}>{entry.qualified.slice(entry.qualified.indexOf("/") + 1)}</span>
                          {entry.capabilities.reasoning === true && <span title="Reasoning-capable" className="shrink-0 rounded bg-[var(--accent-soft)] px-1 py-0.5 text-[9px] font-bold leading-none text-[var(--accent)]">🧠</span>}
                          {selectedSet.has(entry.qualified) && <Check size={13} className="shrink-0 text-[var(--accent)]" />}
                        </button>
                      ))}
                    </div>
                  </section>
                ))}
                {shouldVirtualizeFlat && flatWindow.bottomPadding > 0 && <div style={{ height: flatWindow.bottomPadding }} aria-hidden="true" />}
              </>
            )}
          </div>
        </div>
      </Dialog>
    </>
  );
}

/** Multi-value field: chips + inline catalog browser. */
export function ModelPickerField({
  label,
  hint,
  values,
  onChange,
  mode: _mode,
  disabled: _disabled,
  includeCombos,
  includeAliases,
  includeCustomProviders = true,
}: {
  label: string;
  hint?: string;
  values: string[];
  onChange: (values: string[]) => void;
  mode: PickerMode;
  manualPlaceholder?: string;
  disabled?: boolean;
  /** Combo/alias member lists (e.g. building a combo) must NOT set these - combo members are resolved without alias/combo indirection, so offering them there would produce a config that silently behaves differently from picked. */
  includeCombos?: boolean;
  includeAliases?: boolean;
  /** API-key ACLs keep custom BYOK providers separate from built-in providers. */
  includeCustomProviders?: boolean;
}) {
  const remove = (value: string) => onChange(values.filter((current) => current !== value));
  const [compatSearch, setCompatSearch] = useState("");
  const addCompatValue = () => {
    const nextValue = compatSearch.trim();
    if (!nextValue || values.includes(nextValue)) return;
    onChange([...values, nextValue]);
    setCompatSearch("");
  };
  return (
    <div>
      <Label>{label}</Label>
      {hint && <p className="-mt-1 mb-1.5 text-[10.5px] text-[var(--text-3)]">{hint}</p>}
      {values.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {values.map((value) => (
            <span
              key={value}
              className="inline-flex max-w-full items-center gap-1 overflow-hidden rounded-full border border-[var(--inner-border)] bg-[var(--hover)] px-2 py-0.5 font-mono text-[10.5px] font-medium text-[var(--text-1)]"
            >
              <span className="truncate">{value}</span>
              <button
                type="button"
                onClick={() => remove(value)}
                disabled={_disabled}
                aria-label={`Remove ${value}`}
                className="text-[var(--text-3)] transition-colors hover:text-[var(--red)]"
              >
                <X size={10} />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="sr-only">
        <input placeholder="Search models…" value={compatSearch} onChange={(event) => setCompatSearch(event.target.value)} />
        {compatSearch.trim() && <button type="button" onClick={addCompatValue}>Add "{compatSearch.trim()}"</button>}
      </div>
      <ConfiguredModelPicker
        value={values}
        multiple
        onChange={(nextValues: string | string[]) => onChange(nextValues as string[])}
        includeCombos={includeCombos}
        includeAliases={includeAliases}
        includeCustomProviders={includeCustomProviders}
        placeholder="Add configured models…"
        disabled={_disabled}
      />
    </div>
  );
}

/** Single-value field: input + inline catalog browser. */
export function ModelTargetPicker({
  value,
  onChange,
  placeholder,
  disabled,
  includeCombos = false,
  includeAliases = false,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  includeCombos?: boolean;
  includeAliases?: boolean;
}) {
  return (
    <ConfiguredModelPicker
      value={value}
      onChange={(next: string | string[]) => onChange(next as string)}
      placeholder={placeholder ?? "Select model…"}
      disabled={disabled}
      includeCombos={includeCombos}
      includeAliases={includeAliases}
    />
  );
}
