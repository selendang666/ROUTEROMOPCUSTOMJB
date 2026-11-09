/**
 * Customization — appearance settings rebuilt on top of shared dashboard
 * primitives (Card, Badge, IconBadge, Select, Slider). No bespoke
 * setting-row markup; every section uses the same Card + CardHeader
 * language as Settings / Quota.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Image as ImageIcon, Layers, Palette, RotateCcw, Trash2, Upload } from "lucide-react";
import { useRef, useState, type ChangeEvent } from "react";
import { ConfirmDialog } from "../../components/shared";
import { Badge, Skeleton } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardHeader } from "../../components/ui/card";
import { Select, type SelectOption } from "../../components/ui/select";
import { LabeledSlider } from "../../components/ui/slider";
import { toast } from "../../lib/toast";
import { apiGet, apiPatch } from "../../lib/api";
import { formatBytes } from "../../lib/files";
import { qk } from "../../lib/query-keys";
import {
  BackgroundUpload,
  useCustomizationSettings,
} from "./background";

// ── Types ────────────────────────────────────────────────────────────────────

interface AppearanceSettings {
  sidebarIconDataUrl: string | null;
}

interface AppearanceSettingsResponse {
  appearance: AppearanceSettings;
}

type BackgroundMode = "disabled" | "custom";
type GlassMode = "disabled" | "subtle" | "elevated";

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_SIDEBAR_ICON_URL = `${import.meta.env.BASE_URL}favicon_love.webp`;
const MAX_SIDEBAR_ICON_BYTES = 25 * 1024 * 1024;
const SIDEBAR_ICON_TYPES: Record<string, true> = { "image/png": true, "image/gif": true };

const BACKGROUND_OPTIONS: readonly SelectOption[] = [
  { value: "disabled", label: "Disabled" },
  { value: "custom", label: "Custom" },
];

const GLASS_OPTIONS: readonly SelectOption[] = [
  { value: "disabled", label: "Disabled" },
  { value: "subtle", label: "Subtle glass" },
  { value: "elevated", label: "Elevated glass" },
];

// ── Page ─────────────────────────────────────────────────────────────────────

export function CustomizationPage() {
  const [settings, setSettings] = useCustomizationSettings();
  const [error, setError] = useState<string | null>(null);
  const [confirmResetOpen, setConfirmResetOpen] = useState(false);
  const sidebarIconInputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();
  const asset = settings.backgroundAsset;

  const appearanceQuery = useQuery({
    queryKey: qk.settings.all,
    queryFn: () => apiGet<AppearanceSettingsResponse>("/settings"),
  });

  const appearanceMutation = useMutation({
    mutationFn: (patch: Partial<AppearanceSettings>) =>
      apiPatch<AppearanceSettingsResponse>("/settings", { appearance: patch }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: qk.settings.all }),
    onError: (err) => toast.error(err instanceof Error ? err.message : "Unable to update appearance settings"),
  });

  const appearance = appearanceQuery.data?.appearance;
  const backgroundMode: BackgroundMode = settings.backgroundEnabled ? "custom" : "disabled";
  const glassMode: GlassMode = settings.glassEnabled ? (settings.glassDepth === 2 ? "elevated" : "subtle") : "disabled";

  const hasAppearanceChanges = appearance?.sidebarIconDataUrl != null;
  const hasCustomizationChanges =
    asset !== null ||
    settings.backgroundEnabled ||
    settings.backgroundOpacity !== 21 ||
    settings.backgroundBlur !== 2 ||
    settings.glassEnabled ||
    settings.glassDepth !== 1;

  const resetDisabled = (!hasCustomizationChanges && !hasAppearanceChanges) || appearanceMutation.isPending;

  // ── Handlers ───────────────────────────────────────────────────────────────

  const handleSidebarIconChange = (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const file = input.files?.[0] ?? null;
    input.value = "";
    if (file === null) return;
    if (!SIDEBAR_ICON_TYPES[file.type]) {
      toast.error("Sidebar icon must be a PNG or GIF file");
      return;
    }
    if (file.size > MAX_SIDEBAR_ICON_BYTES) {
      toast.error("Sidebar icon must be 25 MiB or smaller");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      if (typeof dataUrl !== "string" || !/^data:image\/(?:png|gif);base64,/.test(dataUrl)) {
        toast.error("Unable to read sidebar icon");
        return;
      }
      appearanceMutation.mutate(
        { sidebarIconDataUrl: dataUrl },
        { onSuccess: () => toast.success("Sidebar icon updated") },
      );
    };
    reader.onerror = () => toast.error("Unable to read sidebar icon");
    reader.readAsDataURL(file);
  };

  const resetSidebarIcon = () => {
    appearanceMutation.mutate({ sidebarIconDataUrl: null }, { onSuccess: () => toast.success("Sidebar icon reset") });
  };

  const reportError = (message: string) => {
    setError(message);
    toast.error(message);
  };

  const applyReset = () => {
    setSettings({
      backgroundAsset: null,
      backgroundEnabled: false,
      backgroundOpacity: 21,
      backgroundBlur: 2,
      glassEnabled: false,
      glassDepth: 1,
    });
    setError(null);
    if (hasAppearanceChanges) {
      appearanceMutation.mutate(
        { sidebarIconDataUrl: null },
        { onSuccess: () => toast.success("Appearance reset to solid defaults.") },
      );
      return;
    }
    toast.success("Appearance reset to solid defaults.");
  };

  const setBackgroundMode = (mode: string) => {
    setError(null);
    // Turning this off never deletes the uploaded file — it just stops
    // applying it. Deleting the override itself is a separate, explicit
    // action in BackgroundUpload.
    setSettings({ backgroundEnabled: mode === "custom" });
  };

  const setGlassMode = (mode: string) => {
    if (mode === "disabled") {
      setSettings({ glassEnabled: false, glassDepth: 1 });
      return;
    }
    if (mode === "subtle") setSettings({ glassEnabled: true, glassDepth: 1 });
    if (mode === "elevated") setSettings({ glassEnabled: true, glassDepth: 2 });
  };

  // ── Render ─────────────────────────────────────────────────────────────────
  // `dashboard-page` (not a centered max-w column) so this fills the shell
  // exactly like Settings, Providers, Quota, etc. Background gets the wider
  // column since it hosts two sliders + a live preview; Glass and Sidebar
  // icon stack in the narrower column, same asymmetric pattern Settings uses
  // for its Privacy/Limits and Backup/Danger rows.

  return (
    <div className="dashboard-page space-y-4">
      {/* Hero */}
      <Card density="comfortable" surface="elevated">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <CardHeader
            title="Customization"
            sub="Backdrop, glass and sidebar identity — all stored locally. Changes apply instantly."
            icon={Palette}
          />
          <Badge tone="accent" className="shrink-0">
            Local only
          </Badge>
        </div>
      </Card>

      <div className="grid items-start gap-4 lg:grid-cols-[1.3fr_1fr]">
        {/* Background */}
        <Card density="comfortable" surface="elevated">
          <CardHeader title="Background" sub="Choose a backdrop, or keep the dashboard completely solid." icon={ImageIcon} />
          <div className="space-y-4">
            {/* Backdrop selector */}
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <div className="text-xs font-semibold text-[var(--text-1)]">Backdrop</div>
                <div className="mt-0.5 text-[11px] leading-relaxed text-[var(--text-3)]">
                  Custom starts with the built-in picture — upload your own to override it. Disabled removes the image layer entirely.
                </div>
              </div>
              <Select
                value={backgroundMode}
                onChange={setBackgroundMode}
                options={BACKGROUND_OPTIONS}
                ariaLabel="Background mode"
                className="shrink-0"
              />
            </div>

            {/* Conditional content — always occupies space to avoid jump, inner branch switches */}
            <div className="rounded-[var(--radius-control)] border border-[var(--inner-border)] bg-[var(--hover)] p-3">
              {backgroundMode === "disabled" ? (
                <p className="text-[11px] leading-relaxed text-[var(--text-3)]">
                  Backgrounds are disabled — the dashboard stays solid.
                  {asset ? " Your uploaded file is kept and re-applies once you switch back to Custom." : " Switch to Custom to preview."}
                </p>
              ) : (
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-xs font-semibold text-[var(--text-1)]">
                        {asset ? "Custom background" : "Built-in background"}
                      </div>
                      <div className="text-[11px] text-[var(--text-3)]">
                        {asset
                          ? `${asset.kind === "video" ? "Video" : "Image"} · ${formatBytes(asset.blob.size)} · Stored locally`
                          : "Using the default picture. Upload your own to override it — stored locally (IndexedDB)."}
                      </div>
                    </div>
                    <Badge tone={asset ? "accent" : "default"} className="shrink-0">
                      {asset ? (asset.kind === "video" ? "Video" : "Image") : "Default"}
                    </Badge>
                  </div>
                  <BackgroundUpload onError={reportError} />
                </div>
              )}
            </div>

            {/* Sliders — only when backdrop enabled */}
            {backgroundMode !== "disabled" ? (
              <div className="grid gap-4 sm:grid-cols-2">
                <LabeledSlider
                  label="Opacity"
                  description="How strongly the backdrop appears."
                  min={8}
                  max={70}
                  value={settings.backgroundOpacity}
                  valueLabel={`${settings.backgroundOpacity}%`}
                  ariaLabel="Background opacity"
                  onValueChange={(v) => setSettings({ backgroundOpacity: v })}
                />
                <LabeledSlider
                  label="Blur"
                  description="Softness applied to the backdrop."
                  min={0}
                  max={18}
                  value={settings.backgroundBlur}
                  valueLabel={`${settings.backgroundBlur}px`}
                  ariaLabel="Background blur"
                  onValueChange={(v) => setSettings({ backgroundBlur: v })}
                />
              </div>
            ) : null}

            {error ? (
              <div
                role="alert"
                aria-live="polite"
                className="flex items-center gap-2 rounded-[var(--radius-control)] border border-[var(--red)]/20 bg-[var(--red-soft)] px-3 py-2.5 text-xs font-medium text-[var(--red)]"
              >
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--red)]" aria-hidden="true" />
                {error}
              </div>
            ) : null}
          </div>
        </Card>

        {/* Glass + Sidebar icon — narrower column, stacked */}
        <div className="flex flex-col gap-4">
          <Card density="comfortable" surface="elevated">
            <CardHeader
              title="Glass"
              sub="Surface treatment for cards, header, sidebar and modals. Disabled keeps every surface opaque."
              icon={Layers}
            />
            <div className="flex flex-col gap-2">
              <div className="min-w-0">
                <div className="text-xs font-semibold text-[var(--text-1)]">Surface effect</div>
                <div className="mt-0.5 text-[11px] leading-relaxed text-[var(--text-3)]">
                  Subtle adds a light blur; Elevated is stronger and more translucent.
                </div>
              </div>
              <Select
                value={glassMode}
                onChange={setGlassMode}
                options={GLASS_OPTIONS}
                ariaLabel="Glass effect level"
                className="w-full"
              />
            </div>
          </Card>

          {/* Sidebar icon — skeleton while loading, no layout shift */}
          <Card density="comfortable" surface="elevated">
            <CardHeader title="Sidebar icon" sub="Customize the icon shown in the dashboard sidebar." icon={ImageIcon} />
            {appearanceQuery.isPending ? (
              <div className="space-y-3">
                <div className="flex items-center gap-3">
                  <Skeleton className="h-9 w-9 rounded-lg" />
                  <Skeleton className="h-8 w-24 rounded-[var(--radius-control)]" />
                  <Skeleton className="h-8 w-16 rounded-[var(--radius-control)]" />
                </div>
                <Skeleton className="h-3 w-48" />
              </div>
            ) : appearanceQuery.isError ? (
              <div className="flex items-center justify-between gap-3 rounded-[var(--radius-control)] border border-[var(--red)]/15 bg-[var(--red-soft)] px-3 py-2.5 text-xs text-[var(--red)]">
                <span>Unable to load appearance settings.</span>
                <Button variant="ghost" size="sm" onClick={() => void appearanceQuery.refetch()}>
                  Retry
                </Button>
              </div>
            ) : appearance ? (
              <div className="flex flex-col gap-3">
                <div className="flex items-center gap-3">
                  <img
                    src={appearance.sidebarIconDataUrl ?? DEFAULT_SIDEBAR_ICON_URL}
                    alt="Sidebar icon preview"
                    className="h-10 w-10 shrink-0 rounded-xl border border-[var(--inner-border)] bg-[var(--surface-1)] object-cover"
                  />
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs font-semibold text-[var(--text-1)]">
                        {appearance.sidebarIconDataUrl ? "Custom icon" : "Default icon"}
                      </span>
                      <Badge tone={appearance.sidebarIconDataUrl ? "accent" : "default"}>
                        {appearance.sidebarIconDataUrl ? "Active" : "Default"}
                      </Badge>
                    </div>
                    <div className="text-[11px] text-[var(--text-3)]">PNG or animated GIF up to 25 MiB.</div>
                  </div>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  <input
                    ref={sidebarIconInputRef}
                    type="file"
                    accept="image/png,image/gif"
                    className="sr-only"
                    onChange={handleSidebarIconChange}
                    tabIndex={-1}
                    aria-hidden="true"
                  />
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={appearanceMutation.isPending}
                    onClick={() => sidebarIconInputRef.current?.click()}
                  >
                    <Upload size={13} aria-hidden="true" />
                    {appearance.sidebarIconDataUrl ? "Change" : "Upload"}
                  </Button>
                  {appearance.sidebarIconDataUrl ? (
                    <Button variant="ghost" size="sm" disabled={appearanceMutation.isPending} onClick={resetSidebarIcon}>
                      <Trash2 size={13} aria-hidden="true" /> Reset
                    </Button>
                  ) : null}
                </div>
              </div>
            ) : null}
          </Card>
        </div>
      </div>

      {/* Actions */}
      <Card density="comfortable" surface="elevated">
        <CardHeader
          title="Reset appearance"
          sub="Restore the default solid appearance and remove local overrides."
          icon={RotateCcw}
        />
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-control)] border border-[var(--inner-border)] bg-[var(--hover)] px-3 py-3">
          <div className="min-w-0">
            <div className="text-xs font-semibold text-[var(--text-1)]">Reset all appearance settings</div>
            <div className="text-[11px] leading-relaxed text-[var(--text-3)]">
              Disables backgrounds and glass, clears the custom file, and restores the default sidebar icon.
            </div>
          </div>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={() => setConfirmResetOpen(true)}
            disabled={resetDisabled}
            title={resetDisabled && !appearanceMutation.isPending ? "No changes to reset" : undefined}
          >
            <RotateCcw size={13} aria-hidden="true" /> Reset to solid defaults
          </Button>
        </div>
      </Card>

      <ConfirmDialog
        open={confirmResetOpen}
        onClose={() => setConfirmResetOpen(false)}
        onConfirm={() => {
          setConfirmResetOpen(false);
          applyReset();
        }}
        title="Reset appearance?"
        message="This disables backgrounds and glass, removes the custom file stored in this browser, and restores the default sidebar icon. You can re-customize right after."
        confirmLabel="Reset"
      />
    </div>
  );
}
