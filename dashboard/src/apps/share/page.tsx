import { useEffect, useState, type ReactElement } from "react";
import { Activity, Check, Clipboard, Gauge, Home, Sparkles } from "lucide-react";
import { ProviderIcon } from "../../components/provider-icon";
import { copyToClipboard } from "../../lib/helpers.js";
import { useShareData, type ShareMonitorData, type ShareSetupData } from "../../hooks/use-share-data";

const SHARE_BG = `${import.meta.env.BASE_URL}when_yah/ohmyomop-router-god.webp`;

function quotaPct(used: number, limit: number | null): number {
  if (limit === null || limit <= 0) return 0;
  return Math.min(100, Math.max(0, (used / limit) * 100));
}
function fmtNum(v: number | null): string {
  return v === null ? "∞" : v.toLocaleString();
}
// fmtDate kept for future use (Created moved to notes) — suppress noUnusedLocals
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function fmtDate(v: string | null): string { if (!v) return "—"; const d = new Date(v); return Number.isNaN(d.getTime()) ? v : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(d); }
void fmtDate;

function HudCard({ children, className = "" }: { children: React.ReactNode; className?: string }): ReactElement {
  return <div className={`relative overflow-hidden rounded-[18px] border border-white/10 bg-white/[0.06] p-4 backdrop-blur-xl ${className}`}>{children}</div>;
}

export function SharePage(): ReactElement {
  const isSetup = typeof window !== "undefined" && window.location.pathname.startsWith("/share/setup/");
  const dataPath = typeof window !== "undefined" ? `${window.location.pathname.replace(/\/$/, "")}/data` : "";
  const dataState = useShareData<ShareMonitorData | ShareSetupData>(dataPath, isSetup ? undefined : 15000);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    document.title = isSetup ? "Oh My Omop - Router — Setup" : "Oh My Omop - Router — Bansos Token";
  }, [isSetup]);

  const monitor = !isSetup && dataState.data ? dataState.data as ShareMonitorData : null;
  const setup = isSetup && dataState.data ? (dataState.data as ShareSetupData) : null;

  const copy = async (value: string): Promise<void> => {
    const ok = await copyToClipboard(value);
    if (ok) {
      setCopied(value);
      window.setTimeout(() => setCopied((c) => (c === value ? null : c)), 1200);
    }
  };

  if (dataState.loading) {
    return (
      <div className="relative min-h-screen bg-[#050a18] text-white">
        <div className="fixed inset-0 -z-0">
          <img src={SHARE_BG} alt="" className="h-full w-full object-cover opacity-40" />
          <div className="absolute inset-0 bg-gradient-to-t from-[#050a18] via-[#050a18]/60 to-transparent" />
          <div className="absolute inset-0 bg-[radial-gradient(60rem_30rem_at_50%_0%,rgba(125,182,255,0.18),transparent_60%)]" />
        </div>
        <div className="relative z-10 mx-auto max-w-[880px] p-6 pt-16">
          <div className="h-20 animate-pulse rounded-[18px] bg-white/10" />
          <div className="mt-4 h-40 animate-pulse rounded-[18px] bg-white/5" />
        </div>
      </div>
    );
  }
  if (dataState.error) {
    return (
      <div className="relative min-h-screen bg-[#050a18] text-white">
        <div className="fixed inset-0 -z-0">
          <img src={SHARE_BG} alt="" className="h-full w-full object-cover opacity-30" />
          <div className="absolute inset-0 bg-[#050a18]/70 backdrop-blur-[1px]" />
        </div>
        <div className="relative z-10 mx-auto max-w-[520px] p-6 pt-20 text-center">
          <HudCard>
            <p className="font-serif text-[18px]">Not available</p>
            <p className="mt-2 text-[12px] text-white/70">{dataState.error}</p>
            <button onClick={() => window.location.reload()} className="mt-4 rounded-full bg-white px-4 py-2 text-[12px] font-bold text-[#050a18]">Retry</button>
          </HudCard>
        </div>
      </div>
    );
  }
  if (isSetup && setup) {
    return (
      <div className="relative min-h-screen bg-[#050a18] p-6 text-white">
        <div className="fixed inset-0 -z-0">
          <img src={SHARE_BG} alt="" className="h-full w-full object-cover opacity-25" />
          <div className="absolute inset-0 bg-[#050a18]/60" />
        </div>
        <div className="relative z-10 mx-auto max-w-[720px] pt-12">
          <HudCard>
            <h1 className="font-serif text-xl">Setup</h1>
            <pre className="mt-3 overflow-auto rounded-xl bg-black/30 p-4 font-mono text-xs">{JSON.stringify(setup, null, 2)}</pre>
          </HudCard>
        </div>
      </div>
    );
  }
  if (!monitor) {
    return (
      <div className="relative min-h-screen bg-[#050a18] p-6 text-center text-white/70">
        <div className="fixed inset-0 -z-0">
          <img src={SHARE_BG} alt="" className="h-full w-full object-cover opacity-25" />
          <div className="absolute inset-0 bg-[#050a18]/60" />
        </div>
        <p className="relative z-10 pt-20 text-sm">No data</p>
      </div>
    );
  }

  const dailyPct = quotaPct(monitor.dailyUsed, monitor.dailyLimit);
  const monthlyPct = quotaPct(monitor.monthlyUsed, monitor.monthlyLimit);
  const onePct = quotaPct(monitor.oneTimeUsed, monitor.oneTimeLimit);
  const hasNotes = Boolean(monitor.notes?.title || monitor.notes?.subtitle || monitor.notes?.body);
  const allowedModels = monitor.modelAllowlist;
  const shareKey = monitor.apiKey.key;
  const copyAllModels = async (): Promise<void> => {
    if (allowedModels.length === 0) return;
    await copy(allowedModels.join(", "));
  };

  return (
    <div className="relative min-h-screen bg-[#050a18] text-white">
      {/* Game backdrop — fixed, only overlay scrolls */}
      <div className="fixed inset-0 -z-0">
        <img src={SHARE_BG} alt="" className="h-full w-full object-cover object-[50%_22%] opacity-55" />
        <div className="absolute inset-0 bg-gradient-to-t from-[#050a18] via-[#050a18]/55 via-40% to-[#07101d]/20" />
        <div className="absolute inset-0 bg-[radial-gradient(70rem_40rem_at_50%_0%,rgba(125,182,255,0.22),transparent_65%)]" />
        <div className="absolute inset-0 opacity-[0.07]" style={{ backgroundImage: "linear-gradient(rgba(157,234,255,0.9) 1px, transparent 1px), linear-gradient(90deg, rgba(157,234,255,0.9) 1px, transparent 1px)", backgroundSize: "56px 56px" }} />
      </div>

      {/* Header HUD — landing story style */}
      <header className="relative z-10">
        <div className="mx-auto flex max-w-[960px] items-center justify-between gap-3 px-4 py-4 sm:px-6">
          <div className="flex items-center gap-2.5">
            <span className="grid h-8 w-8 place-items-center rounded-xl bg-white text-[#050a18] shadow-[0_6px_20px_rgba(255,255,255,0.2)]">
              <Sparkles size={14} aria-hidden={true} />
            </span>
            <span className="font-serif text-[15px] font-bold tracking-tight">Oh My Omop - Router</span>
          </div>
          <a href="/" className="inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-white/10 px-3 py-1.5 text-[11px] font-bold backdrop-blur hover:bg-white hover:text-[#050a18]">
            <Home size={12} aria-hidden={true} /> Home
          </a>
        </div>
      </header>

      <main className="relative z-10 mx-auto max-w-[960px] px-4 pb-10 pt-4 sm:px-6">
        {/* Title card */}
        <div className="relative overflow-hidden rounded-[22px] border border-white/10 bg-white/[0.07] p-5 backdrop-blur-xl sm:p-7">
          <div className="pointer-events-none absolute -right-10 -top-10 h-40 w-40 rounded-full bg-[radial-gradient(circle,rgba(125,182,255,0.25),transparent_70%)] blur-xl" aria-hidden={true} />
          <h1 className="font-serif text-[28px] font-normal leading-none tracking-tight sm:text-[34px]">{monitor.name || "Shared API Key"}</h1>
          <div className="mt-3 flex flex-wrap gap-2">
            <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold ${monitor.active ? "bg-emerald-500 text-white" : "bg-red-500/90 text-white"}`}>
              <span className="h-1.5 w-1.5 rounded-full bg-white animate-pulse" aria-hidden={true} /> {monitor.active ? "Live" : "Revoked"}
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-white/10 px-2.5 py-1 text-[11px] text-white/80">
              <Activity size={12} aria-hidden={true} /> {monitor.totalRequests ?? 0} requests
            </span>
            <span className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/5 px-2.5 py-1 font-mono text-[11px] text-white/60">
              {monitor.apiKey.id.slice(0, 8)}…{monitor.apiKey.id.slice(-4)}
            </span>
          </div>
        </div>

        {/* Usage — single long bar. If unset (all limits null) show Unlimited, else show limits. */}
        {(() => {
          const isUnlimited = monitor.dailyLimit === null && monitor.monthlyLimit === null && monitor.oneTimeLimit === null;
          const usedTokens = monitor.totalTokens ?? 0;
          const success = monitor.successCount ?? 0;
          const errors = monitor.errorCount ?? 0;
          if (isUnlimited) {
            return (
              <HudCard className="mt-5 !p-0 overflow-hidden">
                <div className="p-4 sm:p-5">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-bold uppercase tracking-[0.14em] text-white/60">Usage</span>
                    <span className="rounded-full bg-white/10 px-2.5 py-1 font-mono text-[11px] font-bold text-white">Unlimited</span>
                  </div>
                  <div className="mt-3 h-3 overflow-hidden rounded-full bg-white/10">
                    <div className="h-full w-full rounded-full bg-gradient-to-r from-cyan-400 via-blue-400 to-violet-400 opacity-90" />
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                    <div className="rounded-xl bg-white/[0.04] px-3 py-2.5">
                      <div className="text-[10px] font-bold uppercase tracking-[0.08em] text-white/40">Used</div>
                      <div className="mt-1 font-mono text-[13px] font-bold text-white">{fmtNum(usedTokens)}<span className="ml-1 text-[11px] font-normal text-white/50">tokens</span></div>
                    </div>
                    <div className="rounded-xl bg-white/[0.04] px-3 py-2.5">
                      <div className="text-[10px] font-bold uppercase tracking-[0.08em] text-white/40">Requests</div>
                      <div className="mt-1 flex items-baseline gap-1.5 font-mono text-[13px] font-bold text-white">{fmtNum(monitor.totalRequests ?? 0)}<span className="text-[11px] font-normal text-white/50">total</span></div>
                    </div>
                    <div className="rounded-xl bg-emerald-500/10 px-3 py-2.5 ring-1 ring-emerald-500/15">
                      <div className="text-[10px] font-bold uppercase tracking-[0.08em] text-emerald-300/80">Success</div>
                      <div className="mt-1 font-mono text-[13px] font-bold text-emerald-300">{fmtNum(success)}</div>
                    </div>
                    <div className="rounded-xl bg-red-500/10 px-3 py-2.5 ring-1 ring-red-500/15">
                      <div className="text-[10px] font-bold uppercase tracking-[0.08em] text-red-300/80">Error</div>
                      <div className="mt-1 font-mono text-[13px] font-bold text-red-300">{fmtNum(errors)}</div>
                    </div>
                  </div>
                </div>
              </HudCard>
            );
          }
          // limited — keep detailed bars but in one card
          return (
            <HudCard className="mt-5">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-bold uppercase tracking-[0.14em] text-white/60">Usage</span>
                <span className="rounded-full bg-white/10 px-2.5 py-1 font-mono text-[11px] font-bold text-white">Limited</span>
              </div>
              <div className="mt-3 grid gap-3">
                {[
                  { label: "Daily", used: monitor.dailyUsed, limit: monitor.dailyLimit, pct: dailyPct },
                  { label: "Monthly", used: monitor.monthlyUsed, limit: monitor.monthlyLimit, pct: monthlyPct },
                  { label: "One-time", used: monitor.oneTimeUsed, limit: monitor.oneTimeLimit, pct: onePct },
                ].filter((q) => q.limit !== null).map((q) => (
                  <div key={q.label} className="rounded-xl bg-white/[0.04] p-3">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-bold uppercase tracking-[0.08em] text-white/60">{q.label}</span>
                      <span className="font-mono text-[11px] font-bold text-white">{fmtNum(q.used)} / {fmtNum(q.limit)}</span>
                    </div>
                    <div className="mt-2 h-2 overflow-hidden rounded-full bg-white/10">
                      <div className="h-full rounded-full bg-gradient-to-r from-cyan-400 to-blue-400" style={{ width: `${q.pct}%` }} />
                    </div>
                  </div>
                ))}
              </div>
              <div className="mt-3 grid grid-cols-3 gap-2 text-center font-mono text-[11px] text-white/50">
                <span>Requests {fmtNum(monitor.totalRequests ?? 0)}</span>
                <span className="text-emerald-300">Success {fmtNum(success)}</span>
                <span className="text-red-300">Error {fmtNum(errors)}</span>
              </div>
            </HudCard>
          );
        })()}

        {/* Base URL + API Key — right after vials — FULL KEY SHOWN */}
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <HudCard className="!p-3">
            <div className="text-[10px] font-bold uppercase tracking-[0.1em] text-white/40">Base URL</div>
            <div className="mt-1.5 flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-white">{monitor.baseUrl || window.location.origin}</span>
              <button onClick={() => copy(monitor.baseUrl || window.location.origin)} className="grid h-7 w-7 shrink-0 place-items-center rounded-full border border-white/10 bg-white/5 text-white/70 hover:bg-white hover:text-[#050a18]" aria-label="Copy Base URL">
                {copied === (monitor.baseUrl || window.location.origin) ? <Check size={12} aria-hidden={true} className="text-emerald-400" /> : <Clipboard size={12} aria-hidden={true} />}
              </button>
            </div>
            <div className="mt-1 font-mono text-[10px] text-white/35">{window.location.origin}/v1</div>
          </HudCard>
          <HudCard className="!p-3">
            <div className="text-[10px] font-bold uppercase tracking-[0.1em] text-white/40">API Key — share, full key</div>
            {shareKey === null ? (
              <p className="mt-1.5 text-[12px] leading-4 text-amber-200">Key predates share-secret storage; create a replacement key.</p>
            ) : (
              <div className="mt-1.5 flex items-center gap-2">
                <span className="min-w-0 flex-1 break-all font-mono text-[12px] leading-4 text-white" title={shareKey}>{shareKey}</span>
                <button onClick={() => copy(shareKey)} className="grid h-7 w-7 shrink-0 place-items-center rounded-full border border-white/10 bg-white/5 text-white/70 hover:bg-white hover:text-[#050a18]" aria-label="Copy API Key">
                  {copied === shareKey ? <Check size={12} aria-hidden={true} className="text-emerald-400" /> : <Clipboard size={12} aria-hidden={true} />}
                </button>
              </div>
            )}
            <div className="mt-1 font-mono text-[10px] text-white/35">Prefix {monitor.apiKey.prefix} · {monitor.apiKey.id.slice(0, 8)}…{monitor.apiKey.id.slice(-4)}</div>
          </HudCard>
        </div>

        {/* Notes — below baseurl/apikey, above models */}
        {hasNotes && (
          <HudCard className="mt-3">
            <div className="text-[10px] font-bold uppercase tracking-[0.1em] text-white/40">Notes</div>
            {monitor.notes.title && <h3 className="mt-2 font-serif text-[16px] font-semibold text-white">{monitor.notes.title}</h3>}
            {monitor.notes.subtitle && <p className="mt-1 text-[12px] font-medium text-cyan-200">{monitor.notes.subtitle}</p>}
            {monitor.notes.body && <p className="mt-2 whitespace-pre-wrap text-[13px] leading-5 text-white/75">{monitor.notes.body}</p>}
          </HudCard>
        )}

        {/* Details — Allowed Models grouped per provider, limit 5 scroll */}
        <HudCard className="mt-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="flex items-center gap-2 text-[12px] font-bold uppercase tracking-[0.1em] text-white/80">
              <Gauge size={13} aria-hidden={true} className="text-cyan-200" /> Allowed Model List
            </h3>
            {allowedModels.length > 0 && (
              <button onClick={copyAllModels} className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-white hover:text-[#050a18]">
                {copied === allowedModels.join(", ") ? <Check size={12} aria-hidden={true} /> : <Clipboard size={12} aria-hidden={true} />} Copy all
              </button>
            )}
          </div>
          {allowedModels.length === 0 ? (
            <div className="mt-3 rounded-xl border border-white/5 bg-white/[0.03] p-3">
              <p className="text-[13px] font-medium text-white">No restriction</p>
              <p className="mt-1 text-[12px] leading-4 text-white/60">All models from your configured providers (oauth / apikey) are available — no allowlist set. Share can use any model your gateway knows.</p>
              {monitor.providerAllowlist && (
                <p className="mt-2 font-mono text-[11px] text-white/50">Provider filter: {monitor.providerAllowlist}</p>
              )}
            </div>
          ) : (
            (() => {
              const groups = new Map<string, string[]>();
              for (const m of allowedModels) {
                const provider = m.includes("/") ? (m.split("/")[0] ?? "other") : "other";
                const list = groups.get(provider) ?? [];
                list.push(m);
                groups.set(provider, list);
              }
              const sorted = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
              return (
                <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {sorted.map(([provider, models]) => (
                    <div key={provider} className="flex flex-col overflow-hidden rounded-2xl border border-white/10 bg-white/[0.04] backdrop-blur">
                      <div className="flex items-center justify-between gap-2 border-b border-white/5 bg-white/[0.03] px-3 py-2.5">
                        <div className="flex min-w-0 items-center gap-2">
                          <ProviderIcon icon={provider} name={provider} size={20} className="rounded-md bg-white/10 !text-white ring-1 ring-white/10" />
                          <span className="truncate font-mono text-[11px] font-bold uppercase tracking-[0.08em] text-white">{provider}</span>
                        </div>
                        <span className="shrink-0 rounded-full bg-cyan-400/15 px-2 py-0.5 font-mono text-[10px] font-bold text-cyan-200">{models.length}</span>
                      </div>
                      <div className="max-h-[212px] overflow-y-auto p-2 [scrollbar-width:thin] [scrollbar-color:rgba(255,255,255,0.18)_transparent] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-white/15 [&::-webkit-scrollbar-track]:bg-transparent">
                        <div className="grid gap-1.5">
                          {models.map((m) => {
                            const short = m.includes("/") ? (m.split("/").slice(1).join("/") ?? m) : m;
                            return (
                              <div
                                key={m}
                                onClick={() => copy(m)}
                                role="button"
                                tabIndex={0}
                                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); copy(m); } }}
                                className="flex cursor-pointer items-center gap-2 rounded-xl border border-white/5 bg-white/[0.03] px-2.5 py-2 transition-colors hover:border-white/15 hover:bg-white/[0.06] active:bg-white/[0.08]"
                                title={`Copy ${m}`}
                              >
                                <span className="min-w-0 flex-1 truncate font-mono text-[11px] leading-none text-white" title={m}>{short}</span>
                                <button
                                  onClick={(e) => { e.stopPropagation(); copy(m); }}
                                  className="grid h-6 w-6 shrink-0 place-items-center rounded-full border border-white/10 bg-white/5 text-white/70 hover:bg-white hover:text-[#050a18]"
                                  aria-label={`Copy ${m}`}
                                  tabIndex={-1}
                                >
                                  {copied === m ? <Check size={11} aria-hidden={true} className="text-emerald-400" /> : <Clipboard size={11} aria-hidden={true} />}
                                </button>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              );
            })()
          )}
        </HudCard>
      </main>
    </div>
  );
}
