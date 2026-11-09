import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldCheck, Zap } from "lucide-react";
import { apiGet, apiPatch } from "../../lib/api";
import { qk } from "../../lib/query-keys";
import { toast } from "../../lib/toast";
import { Badge } from "../../components/ui/badge";
import { Card, CardHeader } from "../../components/ui/card";
import { Select, type SelectOption } from "../../components/ui/select";
import { Switch } from "../../components/ui/switch";

type Quality = "lite" | "balanced" | "extreme";
interface SettingsResponse { runtime: { tokenSaverEnabled: boolean; tokenSaverQuality: Quality; ponytailEnabled: boolean } }
const QUALITY: Array<{ value: Quality; label: string; description: string; saving: string }> = [
  { value: "lite", label: "Lite", description: "Gentle truncation. Keeps more context and is safest for debugging.", saving: "Lower savings" },
  { value: "balanced", label: "Balanced", description: "Recommended compression profile for everyday coding requests.", saving: "Recommended" },
  { value: "extreme", label: "Extreme", description: "Aggressive compression for high-volume sessions; older tool output is shortened more.", saving: "Highest savings" },
];
const QUALITY_OPTIONS: readonly SelectOption[] = QUALITY.map(({ value, label }) => ({ value, label }));

/** Configures the compression Token Saver compression pipeline. */
export function TokenSaverPage() {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: qk.settings.all, queryFn: () => apiGet<SettingsResponse>("/settings") });
  const mutation = useMutation({
    mutationFn: (patch: Partial<{ tokenSaverEnabled: boolean; tokenSaverQuality: Quality; ponytailEnabled: boolean }>) => apiPatch("/settings", { runtime: patch }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: qk.settings.all }),
    onError: (error) => toast.error(error instanceof Error ? error.message : "Unable to update Token Saver"),
  });
  const settings = query.data?.runtime;
  const enabled = settings?.tokenSaverEnabled ?? false;
  const quality = settings?.tokenSaverQuality ?? "balanced";
  const ponytailEnabled = settings?.ponytailEnabled ?? false;
  const activeQuality = QUALITY.find((item) => item.value === quality) ?? QUALITY[1]!;
  return (
    <div className="dashboard-page space-y-4">
      <Card>
        <CardHeader title="Token Saver" icon={Zap} iconColor="#ff9f0a" sub="Choose the compression strategy for older context and tool output" />
        <div className="divide-y divide-[var(--inner-border)]">
          <section className="space-y-3 p-4">
            <div className="flex items-center justify-between gap-4">
              <div><div className="flex items-center gap-2 text-sm font-semibold">Token Saver <Badge tone={enabled ? "ok" : "default"}>{enabled ? "Active" : "Disabled"}</Badge></div><p className="mt-1 text-[11px] text-[var(--text-3)]">Local smart filtering and truncation for older textual tool results. Recent turns remain untouched.</p></div>
              <Switch checked={enabled} onChange={(value) => mutation.mutate({ tokenSaverEnabled: value })} disabled={!settings || mutation.isPending} label="Enable Token Saver" />
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-[14px] border border-[var(--inner-border)] bg-[var(--hover)] p-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-xs font-semibold text-[var(--text-1)]">
                  Compression profile
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-[#ff9f0a]">{activeQuality.saving}</span>
                </div>
                <div className="mt-0.5 text-[11px] leading-relaxed text-[var(--text-3)]">{activeQuality.description}</div>
              </div>
              <Select
                value={quality}
                onChange={(value) => mutation.mutate({ tokenSaverQuality: value as Quality })}
                options={QUALITY_OPTIONS}
                ariaLabel="Compression profile"
                disabled={!settings || mutation.isPending}
                className="shrink-0"
              />
            </div>
            <div className="flex items-start gap-2 rounded-xl border border-[var(--inner-border)] bg-[var(--surface-muted)] p-3 text-[11px] text-[var(--text-3)]"><ShieldCheck size={14} className="mt-0.5 shrink-0 text-[#30d158]" /><span>Token Saver never modifies recent turns, user messages, images, or tool-call arguments. It only bounds older textual tool results.</span></div>
          </section>
          <section className="space-y-3 p-4">
            <div className="flex items-center justify-between gap-4">
              <div><div className="flex items-center gap-2 text-sm font-semibold">Ponytail <Badge tone={ponytailEnabled ? "ok" : "default"}>{ponytailEnabled ? "Active" : "Disabled"}</Badge></div><p className="mt-1 text-[11px] text-[var(--text-3)]">Deterministic system-prompt policy applied once per request when enabled.</p></div>
              <Switch checked={ponytailEnabled} onChange={(value) => mutation.mutate({ ponytailEnabled: value })} disabled={!settings || mutation.isPending} label="Enable Ponytail mode" />
            </div>
          </section>
        </div>
      </Card>
    </div>
  );
}
