/** CLI Tool detail page — dedicated config page for a single tool. */

import { useState, useMemo, useCallback, useEffect } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { ArrowLeft, Download, RotateCcw, Settings2, CheckCircle2, XCircle, Copy, X } from "lucide-react";
import { cn } from "../../lib/cn";
import { toast } from "../../lib/toast";
import { Button } from "../../components/ui/button";
import { Badge } from "../../components/ui/badge";
import { Card } from "../../components/ui/card";
import { Label } from "../../components/ui/input";
import { Switch } from "../../components/ui/switch";
import { Select } from "../../components/ui/select";
import { ConfiguredModelPicker } from "../../components/model-picker";
import { ToolIcon } from "./tool-icon";
import { useToolRegistry, useToolStatuses, useToolMappings, useSaveToolMappings, useApplyTool, useResetTool, useDownloadTool, useApiKeys, fetchApiKeyCredential } from "./api";
import type { ApplyInput, ToolRegistryEntry, ToolStatus } from "./types";
export function CliToolDetailPage() {
  const { toolId } = useParams<{ toolId: string }>();
  const navigate = useNavigate();
  const registryQuery = useToolRegistry();
  const statusesQuery = useToolStatuses();

  const def = useMemo(
    () => registryQuery.data?.find((t) => t.id === toolId) ?? null,
    [registryQuery.data, toolId],
  );

  const status = toolId ? statusesQuery.data?.[toolId] : undefined;

  if (registryQuery.isLoading) {
    return <div className="dashboard-page p-4 text-sm text-[var(--text-3)]">Loading...</div>;
  }

  if (!def) {
    return (
      <div className="dashboard-page space-y-4">
        <p className="text-sm text-[var(--text-3)]">Tool not found.</p>
        <Link to="/cli-tools" className="text-xs text-[var(--accent)]">← Back to CLI Tools</Link>
      </div>
    );
  }

  return <ToolDetailContent def={def} status={status} onBack={() => navigate("/cli-tools")} />;
}


function ToolDetailContent({
  def,
  status,
  onBack,
}: {
  def: ToolRegistryEntry;
  status: ToolStatus | undefined;
  onBack: () => void;
}) {
  const [selectedKeyId, setSelectedKeyId] = useState("");
  const [roleTargets, setRoleTargets] = useState<Record<string, string>>({});
  const [mappingTargets, setMappingTargets] = useState<Record<string, string>>({});
  const [mappingEnabled, setMappingEnabled] = useState(false);
  const [bypassPermissions, setBypassPermissions] = useState(true);
  const [allowedKeyIds, setAllowedKeyIds] = useState<string[]>([]);
  const isNativeClaude = def.id === "claude";
  const mappingMode = def.mappingSupported ? def.mappingMode ?? (isNativeClaude ? "remote" : "custom") : null;
  const isRemoteMapping = mappingMode === "remote";
  const isCustomMapping = mappingMode === "custom";

  const apiKeysQuery = useApiKeys();
  const mappingsQuery = useToolMappings(def.id);
  const saveMappingsMutation = useSaveToolMappings();
  const applyMutation = useApplyTool();
  const resetMutation = useResetTool();
  const downloadMutation = useDownloadTool();
  const roleMappings = useMemo(
    () => (def.defaultModels ?? []).map((model) => ({
      roleKey: model.alias,
      roleLabel: model.roleLabel ?? model.name,
      modelName: model.name,
      roleKind: model.roleKind,
      envKey: model.envKey,
      defaultModel: model.defaultValue ?? model.id,
    })),
    [def.defaultModels],
  );

  useEffect(() => {
    setRoleTargets(Object.fromEntries(roleMappings.map((mapping) => [mapping.roleKey, mapping.defaultModel])));
    setMappingTargets(Object.fromEntries(roleMappings.map((mapping) => [mapping.roleKey, isRemoteMapping ? def.defaultMappingTarget ?? mapping.defaultModel : ""])));
  }, [def.defaultMappingTarget, isRemoteMapping, roleMappings]);

  useEffect(() => {
    const settings = mappingsQuery.data;
    if (!settings) return;
    setMappingEnabled(settings.enabled);
    const persistedMappings = Object.fromEntries(settings.mappings.map((mapping) => [mapping.slotKey, mapping]));
    setRoleTargets((current) => ({
      ...current,
      ...Object.fromEntries(Object.entries(persistedMappings).map(([slotKey, mapping]) => [slotKey, mapping.sourceModel])),
    }));
    setMappingTargets((current) => ({
      ...current,
      ...Object.fromEntries(Object.entries(persistedMappings).map(([slotKey, mapping]) => [slotKey, mapping.targetModel])),
    }));
    if (Array.isArray(settings.allowedApiKeyIds)) {
      setAllowedKeyIds([...settings.allowedApiKeyIds]);
    }
  }, [mappingsQuery.data]);
  const buildMappingInput = useCallback((enabled: boolean) => ({
    enabled,
    mappings: enabled
      ? roleMappings.map((mapping) => {
        if (isCustomMapping) {
          const customModel = roleTargets[mapping.roleKey] ?? mapping.defaultModel;
          return { slotKey: mapping.roleKey, sourceModel: customModel, targetModel: customModel, enabled: true };
        }
        const targetModel = mappingTargets[mapping.roleKey] ?? def.defaultMappingTarget ?? roleTargets[mapping.roleKey] ?? mapping.defaultModel;
        return { slotKey: mapping.roleKey, sourceModel: mapping.roleKey, targetModel, enabled: true };
      }).filter((mapping) => mapping.targetModel.length > 0)
      : [],
    allowedApiKeyIds: allowedKeyIds,
  }), [def.defaultMappingTarget, isCustomMapping, mappingTargets, roleMappings, roleTargets, allowedKeyIds]);

  const handleMappingEnabledChange = useCallback((enabled: boolean) => {
    setMappingEnabled(enabled);
    const input = buildMappingInput(enabled);
    saveMappingsMutation.mutate({ toolId: def.id, input });
  }, [buildMappingInput, def.id, saveMappingsMutation]);

  const isGuide = def.configType === "guide";
  const installed = status?.installed ?? false;
  const configured = status?.configured ?? false;

  const activeKeys = useMemo(
    () => apiKeysQuery.data?.items.filter((k) => k.active) ?? [],
    [apiKeysQuery.data],
  );

  // Auto-select first key on mount.
  useEffect(() => {
    if (!selectedKeyId && activeKeys.length > 0) {
      setSelectedKeyId(activeKeys[0]!.id);
    }
  }, [activeKeys, selectedKeyId]);

  const endpoint = useMemo(() => {
    if (typeof window === "undefined") return "http://localhost:12800";
    return "http://localhost:12800";
  }, []);

  const buildInput = useCallback(async (): Promise<ApplyInput | null> => {
    if (activeKeys.length === 0) {
      toast.error("No active API keys. Create one in API Keys first.");
      return null;
    }
    const keyId = selectedKeyId || activeKeys[0]!.id;
    const apiKey = await fetchApiKeyCredential(keyId);
    if (apiKey === null) {
      toast.error("Failed to fetch API key credential.");
      return null;
    }
    if (apiKey.key === null) {
      toast.error("This key predates secret storage. Create a replacement API key before configuring CLI tools.");
      return null;
    }
    const models = isNativeClaude ? [] : roleMappings.map((mapping) => roleTargets[mapping.roleKey] ?? mapping.defaultModel);
    const modelSlots = isNativeClaude
      ? undefined
      : Object.fromEntries(roleMappings.map((mapping) => [mapping.roleKey, roleTargets[mapping.roleKey] ?? mapping.defaultModel]));
    const subagent = roleMappings.find((mapping) => mapping.roleKind === "subagent");
    const mappings = mappingEnabled
      ? roleMappings.map((mapping) => {
        if (isCustomMapping) {
          const customModel = roleTargets[mapping.roleKey] ?? mapping.defaultModel;
          return { slotKey: mapping.roleKey, sourceModel: customModel, targetModel: customModel, enabled: true };
        }
        const targetModel = mappingTargets[mapping.roleKey] ?? def.defaultMappingTarget ?? roleTargets[mapping.roleKey] ?? mapping.defaultModel;
        return { slotKey: mapping.roleKey, sourceModel: mapping.roleKey, targetModel, enabled: true };
      }).filter((mapping) => mapping.targetModel.length > 0)
      : [];
    return {
      endpoint,
      apiKey: apiKey.key,
      models,
      ...(modelSlots === undefined ? {} : { modelSlots }),
      activeModel: isNativeClaude ? undefined : models[0],
      subagentModel: isNativeClaude || !subagent ? undefined : roleTargets[subagent.roleKey] ?? subagent.defaultModel,
      mapping: def.mappingSupported ? { enabled: mappingEnabled, mappings } : undefined,
      ...(isNativeClaude ? { bypassPermissions } : {}),
    };
  }, [activeKeys, selectedKeyId, endpoint, isNativeClaude, isCustomMapping, roleMappings, roleTargets, mappingTargets, mappingEnabled, bypassPermissions, def.defaultMappingTarget, def.mappingSupported]);

  const handleApply = useCallback(async () => {
    const input = await buildInput();
    if (input) applyMutation.mutate({ toolId: def.id, input });
  }, [buildInput, applyMutation, def.id]);


  const handleReset = useCallback(() => {
    if (!confirm(`Reset ${def.name} config? This removes only Oh My Omop - Router-injected fields.`)) return;
    resetMutation.mutate(def.id);
  }, [def.id, def.name, resetMutation]);

  const handleDownload = useCallback(async () => {
    const input = await buildInput();
    if (input) downloadMutation.mutate({ toolId: def.id, input });
  }, [buildInput, downloadMutation, def.id]);

  const handleCopy = useCallback((text: string, label: string) => {
    navigator.clipboard.writeText(text);
    toast.success(`${label} copied`);
  }, []);

  return (
    <div className="dashboard-page space-y-4">
      {/* Back link */}
      <button
        type="button"
        onClick={onBack}
        className="flex items-center gap-1.5 text-xs text-[var(--text-3)] transition-colors hover:text-[var(--text-1)]"
      >
        <ArrowLeft size={14} />
        Back to CLI Tools
      </button>

      <Card className={cn(configured && "border-[var(--accent)]/40")}>
        <div className="flex items-start gap-3">
          <ToolIcon toolId={def.id} name={def.name} size={44} />
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base font-bold text-[var(--text-1)]">Connect {def.name} to Oh My Omop - Router</h2>
              {installed ? (
                <span className="flex items-center gap-1 text-[10.5px] text-[var(--accent)]"><CheckCircle2 size={12} /> Installed</span>
              ) : (
                <span className="flex items-center gap-1 text-[10.5px] text-[var(--text-3)]"><XCircle size={12} /> Not installed</span>
              )}
              {configured && <Badge tone="accent">CONFIGURED</Badge>}
            </div>
            <p className="text-xs text-[var(--text-2)]">Choose one API key, then assign the model roles this tool uses. Quick Setup writes the configuration to the path shown above.</p>
            {def.settingsFile && <p className="text-[10.5px] font-mono text-[var(--text-3)]">{def.settingsFile}</p>}
          </div>
        </div>
      </Card>

      {/* Guide tools keep their setup instructions below. */}
      {!isGuide && (
        <Card>
          <div className="space-y-5">
            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <Label>1. Oh My Omop - Router API key</Label>
                <Select
                  ariaLabel="Oh My Omop - Router API key"
                  value={selectedKeyId}
                  onChange={setSelectedKeyId}
                  options={activeKeys.length === 0 ? [{ value: "", label: "No active keys — create one first" }] : activeKeys.map((k) => ({ value: k.id, label: `${k.name} (${k.keyPrefix}...)` }))}
                  placeholder={activeKeys.length === 0 ? "No active keys" : "Select API key"}
                  className="mt-1.5 h-10 w-full"
                />
                <p className="mt-1 text-[10.5px] text-[var(--text-3)]">The key is stored in Oh My Omop - Router and injected into the tool config.</p>
              </div>
              <div>
                <Label htmlFor="cli-endpoint">2. Endpoint</Label>
                <input
                  id="cli-endpoint"
                  value={endpoint}
                  readOnly
                  className="mt-1.5 w-full rounded-[var(--radius-control)] border border-[var(--inner-border)] bg-[var(--hover)] px-3 py-2 text-sm text-[var(--text-1)] outline-none"
                />
                <p className="mt-1 text-[10.5px] text-[var(--text-3)]">Automatically points this tool at the local Oh My Omop - Router proxy.</p>
              </div>
              {isNativeClaude && (
                <div className="flex items-start justify-between gap-3 rounded-xl border border-[var(--inner-border)] card-muted p-3 md:col-span-2">
                  <div className="min-w-0">
                    <p className="text-xs font-semibold text-[var(--text-1)]">Add Bypass Permission (YOLO)</p>
                    <p className="mt-0.5 text-[11px] text-[var(--text-3)]">
                      Add <code translate="no">permissions.defaultMode=bypassPermissions</code> and <code translate="no">skipDangerousModePermissionPrompt=true</code> to Claude settings.
                    </p>
                  </div>
                  <Switch checked={bypassPermissions} onChange={setBypassPermissions} label="Add Bypass Permission (YOLO)" />
                </div>
              )}
            </div>
            <div className="border-t border-[var(--inner-border)] pt-4">
              <div className="flex flex-col gap-4">
                {def.mappingSupported && (
                  <div className="flex w-full flex-col gap-3 rounded-xl border border-[var(--inner-border)] card-muted p-3">
                    <div className="flex w-full items-center gap-3">
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-semibold text-[var(--text-1)]">{isRemoteMapping ? "Enable Remote Mapping" : "Enable Custom Mapping"}</p>
                        <p className="mt-0.5 text-[11px] leading-tight text-[var(--text-3)]">
                          {isRemoteMapping
                            ? "Route requests through Oh My Omop - Router without changing the native model ID."
                            : "Expose the selected custom model ID in /models and write that ID to the CLI config."}
                        </p>
                        {isRemoteMapping && def.defaultMappingTarget && <p className="mt-1 text-[10px] text-[var(--accent)]">Recommended: <code translate="no">{def.defaultMappingTarget}</code></p>}
                      </div>
                      {isNativeClaude && isRemoteMapping && (
                        <div className="w-[200px] shrink-0">
                          <Select
                            ariaLabel="Allowed API keys"
                            value=""
                            onChange={(val) => {
                              if (!val || allowedKeyIds.includes(val)) return;
                              const next = [...allowedKeyIds, val];
                              setAllowedKeyIds(next);
                              saveMappingsMutation.mutate({ toolId: def.id, input: { ...buildMappingInput(mappingEnabled), allowedApiKeyIds: next } });
                            }}
                            options={activeKeys.filter((k) => !allowedKeyIds.includes(k.id)).map((k) => ({ value: k.id, label: `${k.name} (${k.keyPrefix}...)` }))}
                            placeholder={activeKeys.length === 0 ? "No active keys" : mappingEnabled ? "Select API key…" : "Enable toggle first"}
                            className="h-8 w-full text-[11px]"
                            disabled={!mappingEnabled || activeKeys.length === 0}
                          />
                        </div>
                      )}
                      <Switch
                        checked={mappingEnabled}
                        onChange={handleMappingEnabledChange}
                        disabled={mappingsQuery.isLoading || saveMappingsMutation.isPending}
                        label={isRemoteMapping ? "Enable Remote Mapping" : "Enable Custom Mapping"}
                      />
                    </div>
                    {isNativeClaude && isRemoteMapping && allowedKeyIds.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 border-t border-[var(--inner-border)] pt-2.5">
                        {allowedKeyIds.map((id) => {
                          const k = activeKeys.find((x) => x.id === id);
                          return (
                            <span key={id} className="inline-flex items-center gap-1 rounded-full border border-[var(--inner-border)] bg-[var(--hover)] px-2.5 py-1 text-[11px] font-mono">
                              {k ? `${k.name} (${k.keyPrefix}...)` : id}
                              <button
                                type="button"
                                onClick={() => {
                                  const next = allowedKeyIds.filter((x) => x !== id);
                                  setAllowedKeyIds(next);
                                  saveMappingsMutation.mutate({ toolId: def.id, input: { ...buildMappingInput(mappingEnabled), allowedApiKeyIds: next } });
                                }}
                                className="text-[var(--text-3)] hover:text-[var(--red)]"
                              >
                                <X size={10} />
                              </button>
                            </span>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}
              </div>
              {isNativeClaude ? (
                <div className="mt-5 overflow-hidden rounded-xl border border-[var(--inner-border)]">
                  <div className="flex items-center justify-between border-b border-[var(--inner-border)] bg-[var(--hover)] px-4 py-2.5">
                    <p className="text-[11px] font-bold text-[var(--text-1)]">Claude Families → Remote Targets</p>
                    <p className="text-[10px] text-[var(--text-3)]">Native match once, target per family</p>
                  </div>
                  <div className="divide-y divide-[var(--inner-border)]">
                    <div className="grid grid-cols-[120px_1fr_260px_32px] gap-3 bg-[var(--surface-muted)]/40 px-4 py-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-3)]">
                      <span>Family</span><span>Native Match</span><span>Remote Target</span><span></span>
                    </div>
                    {roleMappings.map((mapping) => (
                      <div key={mapping.roleKey} className="grid grid-cols-[120px_1fr_260px_32px] items-center gap-3 px-4 py-3 hover:bg-[var(--hover)]/40">
                        <div className="min-w-0">
                          <p className="truncate text-[12px] font-semibold text-[var(--text-1)]">{mapping.roleLabel}</p>
                          <code className="mt-1 inline-block rounded bg-[var(--hover)] px-1.5 py-0.5 text-[10px] text-[var(--text-2)]">{mapping.roleKey}</code>
                        </div>
                        <p className="truncate text-[11px] text-[var(--text-3)]">contains “{mapping.roleKey}”</p>
                        <ConfiguredModelPicker
                          value={mappingTargets[mapping.roleKey] ?? def.defaultMappingTarget ?? roleTargets[mapping.roleKey] ?? mapping.defaultModel}
                          onChange={(value: string) => setMappingTargets((current) => ({ ...current, [mapping.roleKey]: value }))}
                          placeholder="Select provider…"
                          includeCombos={false}
                          includeAliases={false}
                        />
                        <button
                          type="button"
                          onClick={() => setMappingTargets((current) => ({ ...current, [mapping.roleKey]: "" }))}
                          className="grid h-8 w-8 place-items-center rounded-md text-[var(--text-3)] hover:bg-[var(--hover)] hover:text-[var(--text-1)]"
                          title="Clear"
                          aria-label={`Clear ${mapping.roleLabel}`}
                        >
                          <X size={13} />
                        </button>
                      </div>
                    ))}
                  </div>
                  <div className="border-t border-[var(--inner-border)] bg-[var(--hover)]/30 px-4 py-2.5 text-[11px] text-[var(--text-3)]">Quick Setup saves all remote routes without changing native CLI config.</div>
                </div>
              ) : (
                <div className="mt-5 overflow-hidden rounded-xl border border-[var(--inner-border)]">
                  <div className="flex items-center justify-between border-b border-[var(--inner-border)] bg-[var(--hover)] px-4 py-2.5">
                    <p className="text-[11px] font-bold text-[var(--text-1)]">{def.name} → Model Settings</p>
                    <p className="text-[10px] text-[var(--text-3)]">{isRemoteMapping ? "Remote target per role" : isCustomMapping ? "Custom model per role" : "Model per role"}</p>
                  </div>
                  <div className="divide-y divide-[var(--inner-border)]">
                    <div className={`grid gap-3 bg-[var(--surface-muted)]/40 px-4 py-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-3)] ${isRemoteMapping ? "grid-cols-[140px_1fr_260px_32px]" : "grid-cols-[140px_1fr]"}`}>
                      <span>Role</span><span>Model</span>{isRemoteMapping && <><span>Remote Target</span><span></span></>}
                    </div>
                    {roleMappings.map((mapping) => (
                      <div key={mapping.roleKey} className={`grid items-center gap-3 px-4 py-3 hover:bg-[var(--hover)]/40 ${isRemoteMapping ? "grid-cols-[140px_1fr_260px_32px]" : "grid-cols-[140px_1fr]"}`}>
                        <div className="min-w-0">
                          <p className="truncate text-[12px] font-semibold text-[var(--text-1)]">{mapping.roleLabel}</p>
                          <p className="truncate text-[10px] text-[var(--text-3)]">{mapping.envKey ?? mapping.roleKey}</p>
                        </div>
                        <ConfiguredModelPicker
                          value={roleTargets[mapping.roleKey] ?? mapping.defaultModel}
                          onChange={(value: string) => setRoleTargets((current) => ({ ...current, [mapping.roleKey]: value }))}
                          placeholder={mapping.defaultModel}
                          includeCombos={isCustomMapping}
                          includeAliases={isCustomMapping}
                        />
                        {isRemoteMapping && (
                          <>
                            <ConfiguredModelPicker
                              value={mappingTargets[mapping.roleKey] ?? def.defaultMappingTarget ?? roleTargets[mapping.roleKey] ?? mapping.defaultModel}
                              onChange={(value: string) => setMappingTargets((current) => ({ ...current, [mapping.roleKey]: value }))}
                              placeholder="Select provider…"
                              includeCombos={false}
                              includeAliases={false}
                            />
                            <button type="button" onClick={() => setMappingTargets((current) => ({ ...current, [mapping.roleKey]: "" }))} className="grid h-8 w-8 place-items-center rounded-md text-[var(--text-3)] hover:bg-[var(--hover)] hover:text-[var(--text-1)]" title="Clear"><X size={13} /></button>
                          </>
                        )}
                      </div>
                    ))}
                  </div>
                  <div className="border-t border-[var(--inner-border)] bg-[var(--hover)]/30 px-4 py-2.5 text-[11px] text-[var(--text-3)]">Quick Setup saves all model routes without changing native CLI config.</div>
                </div>
              )}
            </div>

            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-[var(--inner-border)] pt-4">
              <Button onClick={handleApply} disabled={applyMutation.isPending || activeKeys.length === 0}>
                <Settings2 size={14} className="mr-1.5" />
                {applyMutation.isPending ? "Applying..." : "Quick Setup"}
              </Button>
              <Button variant="outline" onClick={handleDownload} disabled={downloadMutation.isPending}>
                <Download size={14} className="mr-1.5" />
                {downloadMutation.isPending ? "Downloading..." : "Download"}
              </Button>
              {configured && (
                <Button variant="ghost" onClick={handleReset} disabled={resetMutation.isPending}>
                  <RotateCcw size={14} className="mr-1.5" />
                  {resetMutation.isPending ? "Resetting..." : "Reset"}
                </Button>
              )}
            </div>
          </div>
        </Card>
      )}

      {/* Notes */}
      {def.notes && def.notes.length > 0 && (
        <div className="space-y-1.5">
          {def.notes.map((note, i) => (
            <div
              key={i}
              className={cn(
                "rounded-[var(--radius-control)] border px-3 py-2 text-[11px]",
                note.type === "warning" && "border-[var(--orange-soft)] bg-[var(--orange-soft)] text-[var(--orange)]",
                note.type === "error" && "border-[var(--red-soft)] bg-[var(--red-soft)] text-[var(--red)]",
                note.type === "info" && "border-[var(--teal-soft)] bg-[var(--teal-soft)] text-[var(--teal)]",
              )}
            >
              {note.text}
            </div>
          ))}
        </div>
      )}
      {isGuide && <GuideContent def={def} endpoint={endpoint} onCopy={handleCopy} />}


      {/* Guide tools also get download */}
      {isGuide && (
        <div className="flex gap-2">
          <Button variant="outline" onClick={handleDownload} disabled={downloadMutation.isPending}>
            <Download size={14} className="mr-1.5" />
            {downloadMutation.isPending ? "Downloading..." : "Download Config"}
          </Button>
        </div>
      )}
    </div>
  );
}

/** Guide steps + code block with copy buttons. */
function GuideContent({
  def,
  endpoint,
  onCopy,
}: {
  def: ToolRegistryEntry;
  endpoint: string;
  onCopy: (text: string, label: string) => void;
}) {
  const codeBlock = def.codeBlock;
  const processedCode = useMemo(() => {
    if (!codeBlock) return null;
    return codeBlock.code
      .replace(/\{\{baseUrl\}\}/g, endpoint)
      .replace(/\{\{apiKey\}\}/g, "YOUR_API_KEY")
      .replace(/\{\{model\}\}/g, def.defaultModels[0]?.id ?? "model");
  }, [codeBlock, endpoint, def.defaultModels]);

  return (
    <Card>
      <div className="space-y-3">
        <h3 className="text-xs font-bold uppercase tracking-wider text-[var(--text-3)]">Setup Guide</h3>

        {def.guideSteps?.map((step) => (
          <div key={step.step} className="flex gap-3">
            <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-[var(--surface-muted)] text-[11px] font-bold text-[var(--text-2)]">
              {step.step}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold text-[var(--text-1)]">{step.title}</p>
              {step.desc && <p className="mt-0.5 text-[11px] text-[var(--text-3)]">{step.desc}</p>}
              {step.value && (
                <div className="mt-1.5 flex items-center gap-2">
                  <code className="flex-1 overflow-x-auto rounded-[var(--radius-control)] bg-[var(--surface-muted)] px-2 py-1 text-[10.5px] font-mono text-[var(--text-2)]">
                    {step.value.replace(/\{\{baseUrl\}\}/g, endpoint)}
                  </code>
                  {step.copyable && (
                    <button type="button" onClick={() => onCopy(step.value!.replace(/\{\{baseUrl\}\}/g, endpoint), "Value")} className="shrink-0 text-[var(--text-3)] hover:text-[var(--text-1)]">
                      <Copy size={13} />
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        ))}

        {processedCode && (
          <div className="relative mt-2">
            <pre className="overflow-x-auto rounded-[var(--radius-control)] border border-[var(--inner-border)] bg-[var(--surface-muted)] p-3 text-[10.5px] font-mono leading-relaxed text-[var(--text-2)]">
              {processedCode}
            </pre>
            <button
              type="button"
              onClick={() => onCopy(processedCode, "Config")}
              className="absolute right-2 top-2 rounded p-1.5 text-[var(--text-3)] transition-colors hover:text-[var(--text-1)]"
            >
              <Copy size={14} />
            </button>
          </div>
        )}
      </div>
    </Card>
  );
}
