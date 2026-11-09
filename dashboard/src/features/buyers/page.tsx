import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Activity, KeyRound, Plus, RefreshCw, Share2, Trash2, Users } from "lucide-react";
import { toast } from "../../lib/toast";
import { apiGet, apiPost } from "../../lib/api";
import { copyToClipboard, getErrorMessage } from "../../lib/helpers.js";
import { formatTokens } from "../../lib/format";
import { qk } from "../../lib/query-keys";
import { ClipboardButton } from "../../components/patterns/clipboard-button";
import { Card, CardHeader } from "../../components/ui/card";
import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import { Input, Label } from "../../components/ui/input";
import { Badge } from "../../components/ui/badge";
import { StatePanel, StatCard } from "../../components/ui/state";
import { ConfirmDialog } from "../../components/shared";

export interface BuyerItem {
  id: string;
  apiKeyId: string;
  subdomain: string;
  email: string;
  licenseKey: string;
  expiresAt: string;
  status: string;
  createdAt: string;
  keyActive: boolean;
  keyPrefix: string | null;
  totalUsage: number;
  totalRequests: number;
  lastUsedAt: string | null;
}

interface BuyersQueryData {
  items: BuyerItem[];
}

interface CreatedBuyer {
  buyer: string;
  apiKeyId: string;
  apiKey: string;
  licenseKey: string;
  expiresInDays: number;
  shareUrl: string | null;
}

function statusTone(status: string, keyActive: boolean): "ok" | "warn" | "err" | "default" {
  if (status === "revoked") return "err";
  if (status === "expired" || !keyActive) return "warn";
  if (status === "active") return "ok";
  return "default";
}

export function BuyersPage() {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [revealed, setRevealed] = useState<CreatedBuyer | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<BuyerItem | null>(null);
  const [renewTarget, setRenewTarget] = useState<BuyerItem | null>(null);
  const [form, setForm] = useState({ name: "", email: "", subdomain: "", expiresInDays: "30" });

  const buyersQuery = useQuery({
    queryKey: qk.buyers.all,
    queryFn: () => apiGet<BuyersQueryData>("/buyers"),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: qk.buyers.all });
  };

  const createMutation = useMutation({
    mutationFn: (input: Record<string, unknown>) => apiPost<CreatedBuyer>("/buyers", input),
    onSuccess: (created) => {
      setCreateOpen(false);
      setRevealed(created);
      setForm({ name: "", email: "", subdomain: "", expiresInDays: "30" });
      invalidate();
    },
    onError: (error) => toast.error(getErrorMessage(error, "Failed to create buyer")),
  });

  const revokeMutation = useMutation({
    mutationFn: (id: string) => apiPost(`/buyers/${id}/revoke`, {}),
    onSuccess: () => {
      setRevokeTarget(null);
      invalidate();
      toast.success("Buyer revoked");
    },
    onError: (error) => toast.error(getErrorMessage(error, "Failed to revoke buyer")),
  });

  const renewMutation = useMutation({
    mutationFn: (id: string) => apiPost<CreatedBuyer>(`/buyers/${id}/renew`, { expiresInDays: 30 }),
    onSuccess: (created) => {
      setRenewTarget(null);
      setRevealed(created);
      invalidate();
    },
    onError: (error) => toast.error(getErrorMessage(error, "Failed to renew buyer")),
  });

  const shareMutation = useMutation({
    mutationFn: (id: string) => apiPost<{ url: string }>(`/buyers/${id}/share`, {}),
    onSuccess: async ({ url }) => {
      const copied = await copyToClipboard(url);
      toast[copied ? "success" : "error"](copied ? "Monitor URL copied" : "Monitor URL created; clipboard unavailable");
    },
    onError: (error) => toast.error(getErrorMessage(error, "Failed to create monitor link")),
  });

  if (buyersQuery.isLoading) return <StatePanel kind="loading" title="Loading buyers" />;
  if (buyersQuery.isError) {
    return (
      <StatePanel
        kind="error"
        title="Failed to load buyers"
        description={getErrorMessage(buyersQuery.error)}
        action={<Button variant="secondary" onClick={() => void buyersQuery.refetch()}>Retry</Button>}
      />
    );
  }

  const buyers = buyersQuery.data?.items ?? [];
  const activeBuyers = buyers.filter((b) => b.status === "active" && b.keyActive).length;
  const totalUsage = buyers.reduce((sum, b) => sum + Math.max(0, b.totalUsage), 0);
  const totalRequests = buyers.reduce((sum, b) => sum + Math.max(0, b.totalRequests), 0);

  const submitCreate = () => {
    const expiresInDays = Number(form.expiresInDays);
    createMutation.mutate({
      name: form.name.trim().toLowerCase(),
      email: form.email.trim(),
      subdomain: form.subdomain.trim().toLowerCase(),
      expiresInDays: Number.isFinite(expiresInDays) && expiresInDays > 0 ? Math.floor(expiresInDays) : 30,
    });
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title="Buyers" sub="Opencode buyer keys, licenses, and usage at a glance." icon={Users}>
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus size={13} /> New buyer
          </Button>
        </CardHeader>
        <div className="grid grid-cols-2 gap-2 px-4 pb-4 md:grid-cols-4">
          <StatCard label="Active" icon={Users} tone="neutral" value={activeBuyers} description={`${buyers.length} total`} />
          <StatCard label="Total usage" icon={Activity} tone="info" value={formatTokens(totalUsage)} description="All-time tokens" />
          <StatCard label="Requests" icon={KeyRound} tone="neutral" value={formatTokens(totalRequests)} description="All-time requests" />
          <StatCard label="Exhausted" icon={RefreshCw} tone={buyers.length - activeBuyers > 0 ? "warning" : "neutral"} value={buyers.length - activeBuyers} description="Revoked / inactive" />
        </div>
      </Card>

      {revealed !== null && (
        <Card>
          <CardHeader title="Buyer key — copy now" sub="The full API key is shown once. Store it in the buyer web.env." icon={KeyRound} />
          <div className="space-y-2 px-4 pb-4 text-sm">
            <div className="flex items-center gap-2">
              <span className="w-28 shrink-0 text-[var(--text-3)]">Buyer</span>
              <span className="font-mono">{revealed.buyer}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-28 shrink-0 text-[var(--text-3)]">License</span>
              <span className="font-mono">{revealed.licenseKey}</span>
              <ClipboardButton value={revealed.licenseKey} label="Copy license" />
            </div>
            <div className="flex items-center gap-2">
              <span className="w-28 shrink-0 text-[var(--text-3)]">API key</span>
              <span className="min-w-0 flex-1 break-all font-mono">{revealed.apiKey}</span>
              <ClipboardButton value={revealed.apiKey} label="Copy API key" />
            </div>
            {revealed.shareUrl !== null && (
              <div className="flex items-center gap-2">
                <span className="w-28 shrink-0 text-[var(--text-3)]">Monitor</span>
                <span className="min-w-0 flex-1 break-all font-mono">{revealed.shareUrl}</span>
                <ClipboardButton value={revealed.shareUrl} label="Copy monitor URL" />
              </div>
            )}
            <div>
              <Button variant="secondary" size="sm" onClick={() => setRevealed(null)}>Done</Button>
            </div>
          </div>
        </Card>
      )}

      <Card>
        {buyers.length === 0 ? (
          <StatePanel kind="empty" title="No buyers" description="Create a buyer to issue an isolated router key + license." action={<Button size="sm" onClick={() => setCreateOpen(true)}>New buyer</Button>} />
        ) : (
          <ul className="divide-y divide-white/5">
            {buyers.map((buyer) => (
              <li key={buyer.id} className="flex flex-wrap items-center gap-2 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-sm">{buyer.id}</span>
                    <Badge tone={statusTone(buyer.status, buyer.keyActive)}>{buyer.keyActive ? buyer.status : `${buyer.status} · key off`}</Badge>
                  </div>
                  <div className="mt-1 truncate text-xs text-[var(--text-3)]">
                    {buyer.subdomain} · {buyer.email} · {formatTokens(buyer.totalUsage)} tokens · {formatTokens(buyer.totalRequests)} req
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-1">
                  <Button variant="ghost" size="sm" onClick={() => shareMutation.mutate(buyer.id)} disabled={shareMutation.isPending}>
                    <Share2 size={13} /> Monitor
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setRenewTarget(buyer)} disabled={renewMutation.isPending}>
                    <RefreshCw size={13} /> Renew
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setRevokeTarget(buyer)} disabled={revokeMutation.isPending}>
                    <Trash2 size={13} /> Revoke
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Dialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="New buyer"
        footer={
          <>
            <Button variant="secondary" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button onClick={submitCreate} disabled={createMutation.isPending}>Create buyer</Button>
          </>
        }
      >
        <div className="space-y-3">
          <div>
            <Label htmlFor="buyer-name">Name (a-z, 0-9, hyphen)</Label>
            <Input id="buyer-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="tester01" />
          </div>
          <div>
            <Label htmlFor="buyer-email">Email</Label>
            <Input id="buyer-email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="buyer@example.com" />
          </div>
          <div>
            <Label htmlFor="buyer-subdomain">Subdomain</Label>
            <Input id="buyer-subdomain" value={form.subdomain} onChange={(e) => setForm({ ...form, subdomain: e.target.value })} placeholder="tester01.opencode.claudepeak.com" />
          </div>
          <div>
            <Label htmlFor="buyer-days">License days</Label>
            <Input id="buyer-days" value={form.expiresInDays} onChange={(e) => setForm({ ...form, expiresInDays: e.target.value })} placeholder="30" />
          </div>
        </div>
      </Dialog>

      <ConfirmDialog
        open={revokeTarget !== null}
        onClose={() => setRevokeTarget(null)}
        onConfirm={() => {
          if (revokeTarget !== null) revokeMutation.mutate(revokeTarget.id);
        }}
        title="Revoke buyer"
        message={`Revoke ${revokeTarget?.id ?? ""}? Its router key stops working immediately.`}
        confirmLabel="Revoke"
        danger
      />

      <ConfirmDialog
        open={renewTarget !== null}
        onClose={() => setRenewTarget(null)}
        onConfirm={() => {
          if (renewTarget !== null) renewMutation.mutate(renewTarget.id);
        }}
        title="Renew buyer"
        message={`Issue a fresh key for ${renewTarget?.id ?? ""} (30 days)? The old key is revoked.`}
        confirmLabel="Renew"
      />
    </div>
  );
}
