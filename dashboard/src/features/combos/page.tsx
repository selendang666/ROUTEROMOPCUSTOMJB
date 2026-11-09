/** Combos & Routes — aliases, combos, and fusion routing (no tabs). */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Copy, Pencil, Plus, Route, Trash2, Search, Image as ImageIcon, FileText, Layers } from "lucide-react";
import { useState } from "react";
import { toast } from "../../lib/toast";
import { apiGet, apiPost, apiPatch, apiDelete } from "../../lib/api";
import { qk } from "../../lib/query-keys";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardHeader } from "../../components/ui/card";
import { Dialog } from "../../components/ui/dialog";
import { Input, Label } from "../../components/ui/input";
import { Switch } from "../../components/ui/switch";
import { Select } from "../../components/ui/select";
import { ConfirmDialog } from "../../components/shared";
import { ModelPickerField, ModelTargetPicker } from "../../components/model-picker";

// ── Types ─────────────────────────────────────────────────────────────────

interface AliasRecord { alias: string; model: string; createdAt: string }
interface ComboRecord { id: string; name: string; models: string[]; strategy: "fallback" | "round-robin"; stickyLimit: number }

function RoutingActionButton({ icon: Icon, label, onClick, danger = false }: { icon: typeof Copy; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <Button
      variant="ghost"
      size="sm"
      aria-label={label}
      onClick={onClick}
      className={`h-8 gap-1.5 px-2 text-[11px] ${danger ? "text-[var(--red)] hover:text-[var(--red)]" : "text-[var(--text-2)]"}`}
    >
      <Icon size={14} aria-hidden="true" />
      <span className="hidden sm:inline">{label}</span>
    </Button>
  );
}

async function copyRoutingName(value: string, label: string): Promise<void> {
  try {
    if (!navigator.clipboard) throw new Error("clipboard unavailable");
    await navigator.clipboard.writeText(value);
    toast.success(`${label} copied`);
  } catch {
    toast.error("Clipboard unavailable on this origin");
  }
}

// ── Aliases ───────────────────────────────────────────────────────────────
function AliasesSection() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: qk.aliases.all, queryFn: () => apiGet<{ items: AliasRecord[] }>("/models/aliases") });
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<AliasRecord | null>(null);
  const [alias, setAlias] = useState("");
  const [model, setModel] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  const resetForm = () => {
    setEditTarget(null);
    setAlias("");
    setModel("");
  };

  const createMut = useMutation({
    mutationFn: () => editTarget === null
      ? apiPost("/models/aliases", { alias: alias.trim(), model: model.trim() })
      : apiPatch(`/models/aliases/${encodeURIComponent(editTarget.alias)}`, { model: model.trim() }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.aliases.all });
      setCreateOpen(false);
      resetForm();
      toast.success(editTarget ? "Alias updated" : "Alias created");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const deleteMut = useMutation({
    mutationFn: (a: string) => apiDelete<{ ok: boolean }>(`/models/aliases/${encodeURIComponent(a)}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: qk.aliases.all }); setDeleteTarget(null); toast.success("Alias deleted"); },
    onError: (e: Error) => toast.error(e.message),
  });

  const items = data?.items ?? [];

  return (
    <Card>
      <CardHeader title="Aliases" icon={Route} sub="Map readable names to model targets">
        <Button size="sm" onClick={() => setCreateOpen(true)}><Plus size={14} /> New Alias</Button>
      </CardHeader>
      <p className="mb-3 text-xs text-[var(--text-2)]">Map readable names to model targets (e.g. <code>claude-mythos-5</code> → <code>claude-opus-5</code>).</p>
      {items.length === 0 ? (
        <div className="flex min-h-[140px] items-center justify-center rounded-xl border border-dashed border-[var(--inner-border)] bg-[var(--hover)]/40 px-3 py-6 text-center">
          <p className="text-sm text-[var(--text-3)]">No aliases defined yet.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {items.map((a) => (
            <div key={a.alias} className="flex items-center gap-3 rounded-xl border border-[var(--inner-border)] bg-[var(--hover)] px-4 py-2.5">
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2 text-sm">
                <code className="shrink-0 break-words rounded bg-[var(--accent-soft)] px-1.5 py-0.5 text-xs font-semibold text-[var(--accent)]">{a.alias}</code>
                <ArrowRight size={14} className="shrink-0 text-[var(--text-3)]" />
                <code className="min-w-0 flex-1 break-words whitespace-normal text-xs text-[var(--text-2)]">{a.model}</code>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <RoutingActionButton icon={Copy} label="Copy" onClick={() => void copyRoutingName(a.alias, "Alias")} />
                <RoutingActionButton icon={Pencil} label="Edit" onClick={() => { setEditTarget(a); setAlias(a.alias); setModel(a.model); setCreateOpen(true); }} />
                <RoutingActionButton icon={Trash2} label="Delete" danger onClick={() => setDeleteTarget(a.alias)} />
              </div>
            </div>
          ))}
        </div>
      )}
      <Dialog open={createOpen} onClose={() => { setCreateOpen(false); resetForm(); }} title={editTarget ? "Edit Alias" : "New Alias"}
        footer={<><Button variant="secondary" onClick={() => { setCreateOpen(false); resetForm(); }}>Cancel</Button><Button disabled={!alias.trim() || !model.trim()} onClick={() => createMut.mutate()}>{editTarget ? "Save" : "Create"}</Button></>}>
        <div className="space-y-3">
          <div><Label htmlFor="alias-name">Alias name</Label><Input id="alias-name" placeholder="e.g. fast" value={alias} onChange={(e) => setAlias(e.target.value)} disabled={!!editTarget} /></div>
          <div><Label htmlFor="alias-model">Target model (qualified or combo name)</Label><ModelTargetPicker value={model} onChange={setModel} placeholder="e.g. claude-opus-5" /></div>
        </div>
      </Dialog>
      <ConfirmDialog open={deleteTarget !== null} onClose={() => setDeleteTarget(null)} onConfirm={() => deleteTarget && deleteMut.mutate(deleteTarget)} title="Delete alias?" message={`Remove alias "${deleteTarget}"? Requests using this alias will need their full model name.`} confirmLabel="Delete" danger />
    </Card>
  );
}

// ── Combos ────────────────────────────────────────────────────────────────
function CombosSection() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: qk.combos.all, queryFn: () => apiGet<{ items: ComboRecord[] }>("/models/combos") });
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<ComboRecord | null>(null);
  const [name, setName] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [stickyLimit, setStickyLimit] = useState("0");
  const [deleteTarget, setDeleteTarget] = useState<ComboRecord | null>(null);

  const resetForm = () => { setName(""); setModels([]); setStickyLimit("0"); setEditTarget(null); };
  const createMut = useMutation({
    mutationFn: () => {
      const body = { name: name.trim(), models, stickyLimit: Math.max(0, Number(stickyLimit) || 0) };
      return editTarget
        ? apiPatch(`/models/combos/${editTarget.id}`, body)
        : apiPost("/models/combos", { ...body, strategy: "fallback" });
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: qk.combos.all }); setCreateOpen(false); resetForm(); toast.success(editTarget ? "Combo updated" : "Combo created"); },
    onError: (e: Error) => toast.error(e.message),
  });

  const strategyMut = useMutation({
    mutationFn: ({ id, strategy }: { id: string; strategy: ComboRecord["strategy"] }) => apiPatch(`/models/combos/${id}`, { strategy }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: qk.combos.all }); toast.success("Strategy updated"); },
    onError: (e: Error) => toast.error(e.message),
  });
  const deleteMut = useMutation({
    mutationFn: (id: string) => apiDelete<{ ok: boolean }>(`/models/combos/${id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: qk.combos.all }); setDeleteTarget(null); toast.success("Combo deleted"); },
    onError: (e: Error) => toast.error(e.message),
  });

  const openEdit = (c: ComboRecord) => {
    setEditTarget(c); setName(c.name); setModels(c.models); setStickyLimit(String(c.stickyLimit)); setCreateOpen(true);
  };

  const items = (data?.items ?? []).filter((c) => !c.name.startsWith("fusion:"));

  return (
    <Card>
      <CardHeader title="Combos" icon={Route} sub="Combine multiple models with fallback or round-robin.">
        <Button size="sm" onClick={() => { resetForm(); setCreateOpen(true); }}><Plus size={14} /> New Combo</Button>
      </CardHeader>
      {items.length === 0 ? (
        <div className="flex min-h-[140px] items-center justify-center rounded-xl border border-dashed border-[var(--inner-border)] bg-[var(--hover)]/40 px-3 py-6 text-center">
          <p className="text-sm text-[var(--text-3)]">No combos defined yet.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {items.map((c) => (
            <div key={c.id} className="rounded-xl border border-[var(--inner-border)] bg-[var(--hover)] px-4 py-3">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                  <span className="break-words text-sm font-bold">{c.name}</span>
                  {c.stickyLimit > 0 && <Badge>sticky:{c.stickyLimit}</Badge>}
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2 sm:shrink-0 sm:justify-end">
                  <Select
                    ariaLabel={`Strategy for ${c.name}`}
                    value={c.strategy}
                    onChange={(value) => strategyMut.mutate({ id: c.id, strategy: value as ComboRecord["strategy"] })}
                    options={[{ value: "fallback", label: "Fallback — try in order" }, { value: "round-robin", label: "Round Robin — rotate" }]}
                    disabled={strategyMut.isPending}
                    className="h-9 max-w-full"
                  />
                  <div className="flex items-center gap-1">
                    <RoutingActionButton icon={Copy} label="Copy" onClick={() => void copyRoutingName(c.name, "Combo")} />
                    <RoutingActionButton icon={Pencil} label="Edit" onClick={() => openEdit(c)} />
                    <RoutingActionButton icon={Trash2} label="Delete" danger onClick={() => setDeleteTarget(c)} />
                  </div>
                </div>
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {c.models.map((m) => <code key={m} className="rounded bg-[var(--accent-soft)] px-1.5 py-0.5 text-[10.5px] text-[var(--accent)]">{m}</code>)}
              </div>
            </div>
          ))}
        </div>
      )}
      <Dialog open={createOpen} onClose={() => { setCreateOpen(false); resetForm(); }} title={editTarget ? "Edit Combo" : "New Combo"} wide
        footer={<><Button variant="secondary" onClick={() => { setCreateOpen(false); resetForm(); }}>Cancel</Button><Button disabled={!name.trim() || models.length < 2} onClick={() => createMut.mutate()}>{editTarget ? "Save" : "Create"}</Button></>}>
        <div className="space-y-3">
          <div><Label htmlFor="combo-name">Name</Label><Input id="combo-name" placeholder="e.g. fast-combo" value={name} onChange={(e) => setName(e.target.value)} disabled={!!editTarget} /></div>
          <ModelPickerField label="Models (at least 2, qualified prefix/model)" values={models} onChange={setModels} mode="models" manualPlaceholder="e.g. kimchi/kimi-k2.7" />
          <div><Label htmlFor="combo-sticky">Sticky limit</Label><Input id="combo-sticky" type="number" min={0} value={stickyLimit} onChange={(e) => setStickyLimit(e.target.value)} className="w-24" /></div>
        </div>
      </Dialog>
      <ConfirmDialog open={deleteTarget !== null} onClose={() => setDeleteTarget(null)} onConfirm={() => deleteTarget && deleteMut.mutate(deleteTarget.id)} title="Delete combo?" message={`Remove combo "${deleteTarget?.name}"? Any aliases pointing to it will no longer resolve.`} confirmLabel="Delete" danger />
    </Card>
  );
}

// ── Fusion ────────────────────────────────────────────────────────────────
const FUSION_CATEGORIES = [
  { id: "fusion:websearch", label: "Websearch", icon: Search, desc: "Web search capable" },
  { id: "fusion:vision", label: "Vision (image/video)", icon: ImageIcon, desc: "Image & video" },
  { id: "fusion:pdf", label: "PDF", icon: FileText, desc: "PDF / document" },
  { id: "fusion:multimodal", label: "Multimodal", icon: Layers, desc: "All vision+pdf" },
] as const;

function FusionCard({ category }: { category: typeof FUSION_CATEGORIES[number] }) {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: qk.combos.all, queryFn: () => apiGet<{ items: ComboRecord[] }>("/models/combos") });
  const combo = (data?.items ?? []).find((c) => c.name === category.id) ?? null;
  const [models, setModels] = useState<string[]>([]);
  const [editing, setEditing] = useState(false);

  // sync when combo loads
  const effectiveModels = editing ? models : combo?.models ?? [];
  const isRoundRobin = combo?.strategy === "round-robin";

  const upsertMut = useMutation({
    mutationFn: () => {
      if (combo) return apiPatch(`/models/combos/${combo.id}`, { models: effectiveModels, strategy: combo.strategy, stickyLimit: combo.stickyLimit });
      return apiPost("/models/combos", { name: category.id, models: effectiveModels, strategy: "fallback", stickyLimit: 1 });
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: qk.combos.all }); setEditing(false); toast.success(combo ? "Fusion updated" : "Fusion created"); },
    onError: (e: Error) => toast.error(e.message),
  });

  const strategyMut = useMutation({
    mutationFn: (strategy: ComboRecord["strategy"]) => {
      if (!combo) return apiPost("/models/combos", { name: category.id, models: [], strategy, stickyLimit: strategy === "fallback" ? 1 : 0 });
      const stickyLimit = strategy === "fallback" && combo.stickyLimit === 0 ? 1 : combo.stickyLimit;
      return apiPatch(`/models/combos/${combo.id}`, { strategy, stickyLimit });
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: qk.combos.all }); toast.success("Strategy updated"); },
    onError: (e: Error) => toast.error(e.message),
  });

  const startEdit = () => {
    setModels(combo?.models ?? []);
    setEditing(true);
  };

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-[var(--inner-border)] bg-[var(--hover)] p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="grid size-7 place-items-center rounded-lg bg-[var(--accent-soft)] text-[var(--accent)]"><category.icon size={14} /></span>
          <div>
            <div className="text-xs font-semibold">{category.label}</div>
            <div className="text-[10px] text-[var(--text-3)]">{category.desc}</div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-medium text-[var(--text-2)]">{isRoundRobin ? "Round-robin" : "Sticky"}</span>
          <Switch checked={!!isRoundRobin} onChange={(v) => strategyMut.mutate(v ? "round-robin" : "fallback")} label={`Round robin ${category.label}`} />
        </div>
      </div>

      {!editing ? (
        <>
          <div className="min-h-[44px] rounded-lg border border-dashed border-[var(--inner-border)] bg-[var(--surface-1)] px-2 py-2">
            {combo && combo.models.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {combo.models.map((m) => <code key={m} className="rounded bg-[var(--accent-soft)] px-1.5 py-0.5 text-[10.5px] text-[var(--accent)]">{m}</code>)}
              </div>
            ) : (
              <p className="text-center text-xs text-[var(--text-3)]">No models — add to route.</p>
            )}
          </div>
          <div className="flex gap-2">
            <Button size="sm" className="flex-1" onClick={startEdit}><Plus size={12} /> {combo ? "Edit models" : "Add models"}</Button>
          </div>
        </>
      ) : (
        <>
          <ModelPickerField label="Models" values={models} onChange={setModels} mode="models" manualPlaceholder="e.g. openai/gpt-4" />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => setEditing(false)}>Cancel</Button>
            <Button size="sm" disabled={models.length === 0} onClick={() => upsertMut.mutate()}>{upsertMut.isPending ? "Saving…" : "Save"}</Button>
          </div>
        </>
      )}
    </div>
  );
}

function FusionSection() {
  return (
    <Card>
      <CardHeader title="Fusion" icon={Layers} sub="Capability-based routing — websearch, vision, pdf, multimodal" />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {FUSION_CATEGORIES.map((cat) => <FusionCard key={cat.id} category={cat} />)}
      </div>
      <p className="mt-3 text-[11px] text-[var(--text-3)]">Round-robin cycles models; fallback stays sticky (default). Each fusion target is a combo named <code>fusion:*</code>.</p>
    </Card>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────
export function CombosPage() {
  return (
    <div className="dashboard-page space-y-6">
      <CombosSection />
      <AliasesSection />
      <FusionSection />
    </div>
  );
}
