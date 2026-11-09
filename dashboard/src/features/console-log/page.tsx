/**
 * Console Log page — live SSE stream with colored levels, auto-scroll
 * (paused when the user scrolls up), SQL-backed 200-line view cap and
 * server-side clear (REQ-6).
 */

import { memo, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { Search, Trash2 } from "lucide-react";
import { toast } from "../../lib/toast";
import { ApiError, apiDelete } from "../../lib/api";
import { formatTime } from "../../lib/format";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { Select } from "../../components/ui/select";
import { ConfirmDialog } from "../../components/shared";
import {
  buildSearchBlob,
  useConsoleLogStream,
  type ConsoleLogCategory,
  type ConsoleLogContext,
  type ConsoleLogLine,
  type ConsoleLogLevel,
} from "../../hooks/use-console-log-stream";

const LEVEL_COLORS: Record<ConsoleLogLevel, string> = {
  debug: "text-[var(--text-3)]",
  info: "text-[#0fa3d1] dark:text-[var(--teal)]",
  warn: "text-[var(--orange)]",
  error: "text-[var(--red)]",
};

type LogLevelFilter = ConsoleLogLevel | "all";
const CATEGORIES: Array<{ value: ConsoleLogCategory; label: string }> = [
  { value: "all", label: "All logs" },
  { value: "request", label: "Request logs" },
  { value: "system", label: "System logs" },
  { value: "web", label: "Web logs" },
];
const LEVELS: Array<{ value: LogLevelFilter; label: string }> = [
  { value: "all", label: "All levels" },
  { value: "debug", label: "debug" },
  { value: "info", label: "info" },
  { value: "warn", label: "warn" },
  { value: "error", label: "error" },
];

type LifecycleEvent = "incoming" | "complete" | "failed" | "aborted" | "switch";

const EVENT_ICONS: Record<LifecycleEvent, string> = {
  incoming: "🔵",
  complete: "🟢",
  failed: "🔴",
  aborted: "🟠",
  switch: "🟡",
};

function eventOf(line: ConsoleLogLine): LifecycleEvent | null {
  const event = line.context?.event;
  if (event === "incoming" || event === "complete" || event === "failed" || event === "aborted" || event === "switch") return event;
  return null;
}

function shortId(value: string | null | undefined, length = 8): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  return value.length > length ? `${value.slice(0, length)}…` : value;
}

function displayValue(value: string | null | undefined, fallback = "—"): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function numberValue(value: number | null | undefined, fallback = "—"): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : fallback;
}

function durationValue(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return `${Math.round(value * 100) / 100}ms`;
}

function requestIdFor(context: ConsoleLogContext): string {
  return shortId(context.requestId) ?? "unknown";
}

function statusFor(context: ConsoleLogContext): string {
  return context.event === "aborted" ? "499" : numberValue(context.status);
}

function routeFor(context: ConsoleLogContext): string | null {
  const provider = displayValue(context.providerId, "");
  const model = displayValue(context.model, "");
  if (provider.length === 0 && model.length === 0) return null;
  if (provider.length === 0) return model;
  if (model.length === 0) return provider;
  return `${provider}/${model}`;
}

function cacheFor(context: ConsoleLogContext): string {
  const cache = numberValue(context.cachedTokens);
  let cacheState = "unknown";
  if (context.cachedTokens !== null && context.cachedTokens !== undefined) {
    cacheState = context.cachedTokens > 0 ? "hit" : "miss";
  }
  return `cache=${cache} (${cacheState})`;
}

function usageFor(context: ConsoleLogContext): string {
  const usage = [
    context.inputTokens === null || context.inputTokens === undefined ? null : `in=${numberValue(context.inputTokens)}`,
    context.outputTokens === null || context.outputTokens === undefined ? null : `out=${numberValue(context.outputTokens)}`,
    cacheFor(context),
    context.cacheWriteTokens === null || context.cacheWriteTokens === undefined ? "cachew=—" : `cachew=${numberValue(context.cacheWriteTokens)}`,
    context.reasoningTokens === null || context.reasoningTokens === undefined ? "think=—" : `think=${numberValue(context.reasoningTokens)}`,
  ].filter((value): value is string => value !== null);
  return usage.length === 0 ? "usage=—" : usage.join(" ");
}

function countsFor(context: ConsoleLogContext): string {
  return [
    `messages=${numberValue(context.messageCount)}`,
    `tools=${numberValue(context.toolCount)}`,
    `images=${numberValue(context.imageCount)}`,
  ].join(" ");
}

function eventTone(line: ConsoleLogLine): string {
  const event = eventOf(line);
  if (event === "failed") return "text-[var(--red)]";
  if (event === "switch" || event === "aborted") return "text-[var(--orange)]";
  if (event === "complete") return "text-[#0fa3d1] dark:text-[var(--teal)]";
  return LEVEL_COLORS[line.level];
}

interface FormattedLogLine {
  readonly icon: string;
  readonly label: string;
  readonly summary: string;
  readonly detail: string | null;
}

function joinTokens(tokens: Array<string | null | undefined>): string {
  return tokens.filter((value): value is string => Boolean(value)).join(" · ");
}

function humanReadableLine(line: ConsoleLogLine): FormattedLogLine {
  const context = line.context;
  if (context === null || context === undefined) {
    return { icon: "•", label: line.level.toUpperCase(), summary: line.msg, detail: null };
  }

  const event = eventOf(line);
  const requestId = requestIdFor(context);
  const route = routeFor(context);
  const account = shortId(context.accountId) ?? "none";
  const modelToken = route === null ? null : `model=${route}`;
  const accountToken = `account=${account}`;
  const proxyToken = `proxy=${context.proxyId === null || context.proxyId === undefined ? "direct" : shortId(context.proxyId) ?? context.proxyId}`;
  const clientToken = `client=${displayValue(context.clientName, "unknown")}/${displayValue(context.clientSource, "unknown")}`;
  const ipToken = `ip=${context.clientIp ?? "unknown"}`;
  const counts = countsFor(context);
  const requestToken = `request=${requestId}`;
  const common = joinTokens([requestToken, modelToken, accountToken, proxyToken]);
  const requestDetail = joinTokens([requestToken, counts, proxyToken, accountToken]);
  const detail = joinTokens([requestToken, `tokens: ${usageFor(context)}`, counts, proxyToken, accountToken]);

  if (event === "incoming") {
    return {
      icon: EVENT_ICONS.incoming,
      label: "Incoming Request",
      summary: joinTokens([context.endpoint ? `POST ${context.endpoint}` : "POST /v1", modelToken, clientToken, ipToken]),
      detail: requestDetail,
    };
  }
  if (event === "switch") {
    const switchDetails = context.switch;
    const transition = `${displayValue(switchDetails?.fromCandidateId)} → ${displayValue(switchDetails?.toCandidateId)}`;
    return {
      icon: EVENT_ICONS.switch,
      label: "Route Switch",
      summary: joinTokens([transition, `reason=${displayValue(switchDetails?.reason, displayValue(context.errorKind))}`]),
      detail: joinTokens([statusFor(context) === "—" ? null : `status=${statusFor(context)}`, common, clientToken, ipToken, counts]),
    };
  }
  if (event === "aborted") {
    return {
      icon: EVENT_ICONS.aborted,
      label: "Response Aborted by Client",
      summary: joinTokens(["499", modelToken, clientToken, ipToken, durationValue(context.durationMs)]),
      detail,
    };
  }
  if (event === "failed") {
    return {
      icon: EVENT_ICONS.failed,
      label: "Request Failed",
      summary: joinTokens([statusFor(context), modelToken, clientToken, ipToken, `error=${displayValue(context.errorKind)}`, durationValue(context.durationMs)]),
      detail,
    };
  }
  if (event === "complete") {
    return {
      icon: EVENT_ICONS.complete,
      label: "Request Complete",
      summary: joinTokens([statusFor(context), modelToken, clientToken, ipToken, durationValue(context.durationMs)]),
      detail,
    };
  }
  return { icon: "•", label: line.level.toUpperCase(), summary: line.msg, detail: null };
}

const ConsoleLogRow = memo(function ConsoleLogRow({
  line,
  isNew,
}: {
  line: ConsoleLogLine;
  isNew: boolean;
}) {
  const formatted = humanReadableLine(line);
  return (
    <div
      className={`min-w-max border-l-2 px-2 py-1 transition-colors duration-300 ${isNew ? "border-[var(--accent)] bg-[var(--accent-soft)] shadow-[0_0_0_1px_var(--accent)]" : "border-transparent hover:bg-[var(--hover)]"}`}
      style={{ contentVisibility: "auto", containIntrinsicSize: "0 24px" }}
    >
      <div className="flex items-baseline gap-2 whitespace-nowrap">
        <span className="shrink-0 text-[var(--text-3)]">{formatTime(line.ts)}</span>
        <span aria-hidden="true">{formatted.icon}</span>
        <span className={`shrink-0 font-semibold ${eventTone(line)}`}>{formatted.label}:</span>
        <span className={`min-w-0 ${eventTone(line)}`}>{formatted.summary}</span>
      </div>
      {formatted.detail !== null ? (
        <div className="whitespace-nowrap pl-[8.2rem] text-[var(--text-2)]">
          {formatted.detail}
        </div>
      ) : null}
    </div>
  );
});

// ── Console Log tab ──────────────────────────────────────────────────────────

function ConsoleLogTab() {
  const [category, setCategory] = useState<ConsoleLogCategory>("request");
  const [level, setLevel] = useState<LogLevelFilter>("all");
  const { lines, newLineIds, reset } = useConsoleLogStream(category);
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [autoScroll, setAutoScroll] = useState(true);
  const [clearOpen, setClearOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const visible = useMemo(() => {
    const query = deferredSearch.trim().toLowerCase();
    // lines is already newest-first (descending id) from the hook's ring buffer;
    // filtering preserves that order without an extra sort.
    if (level === "all" && !query) return lines;
    return lines.filter((line) => {
      if (level !== "all" && line.level !== level) return false;
      if (!query) return true;
      const blob = line.searchBlob ?? buildSearchBlob(line);
      return blob.includes(query);
    });
  }, [level, lines, deferredSearch]);

  useEffect(() => {
    if (!autoScroll) return;
    const el = scrollRef.current;
    if (el && typeof el.scrollTo === "function") el.scrollTo({ top: 0, behavior: "auto" });
  }, [visible.length, level, autoScroll]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atLatest = el.scrollTop < 40;
    setAutoScroll(atLatest);
  };

  const clearLogs = async () => {
    try {
      await apiDelete<{ ok: boolean }>("/logs");
      reset();
      setClearOpen(false);
      toast.success("Console logs cleared");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "failed to clear logs");
    }
  };

  const categoryLabel = CATEGORIES.find((option) => option.value === category)?.label ?? "All logs";
  const levelLabel = LEVELS.find((option) => option.value === level)?.label ?? "All levels";

  return (
    <>
      <div className="flex w-full flex-wrap items-center gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-3)]">Console Logs</h3>
        <div className="flex w-full flex-wrap items-center justify-end gap-2">
          <div className="relative order-last w-full sm:order-none sm:mr-auto sm:w-56">
            <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-3)]" aria-hidden="true" />
            <Input
              aria-label="Search console logs"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search console logs..."
              className="h-8 pl-8 pr-2 text-xs"
            />
          </div>
          <Select
            ariaLabel="Log category"
            value={category}
            onChange={(value) => setCategory(value as ConsoleLogCategory)}
            options={CATEGORIES}
          />
          <Select
            ariaLabel="Log level"
            value={level}
            onChange={(value) => setLevel(value as LogLevelFilter)}
            options={LEVELS}
          />
          <Button variant="secondary" size="sm" onClick={() => setClearOpen(true)}>
            <Trash2 size={13} /> Clear
          </Button>
        </div>
      </div>

      <Card className="flex min-h-0 flex-1 flex-col overflow-hidden p-0">
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="min-h-0 flex-1 overflow-auto overscroll-contain p-3 font-mono text-[11.5px] leading-relaxed"
        >
          {visible.length === 0 ? (
            <div className="flex h-full min-h-[220px] items-center justify-center">
              <p className="text-center font-sans text-sm text-[var(--text-1)]">
                No log lines{category !== "all" || level !== "all" ? ` in ${categoryLabel}${level !== "all" ? ` · ${levelLabel}` : ""}` : ""}.
              </p>
            </div>
          ) : (
            visible.map((line) => <ConsoleLogRow key={line.id} line={line} isNew={newLineIds.has(line.id)} />)
          )}
        </div>
        <footer className="flex min-w-0 shrink-0 flex-wrap items-center justify-between gap-2 border-t border-[var(--inner-border)] bg-[var(--hover)] px-3 py-2 text-[10px] text-[var(--text-3)]">
          <span className="min-w-0 max-w-full overflow-hidden text-ellipsis whitespace-nowrap" aria-live="polite">
            Showing {visible.length} of {lines.length} lines · {categoryLabel}
            {level !== "all" ? ` · ${levelLabel}` : ""}
            {search.trim() ? ` · search: "${search.trim()}"` : ""}
          </span>
          <span className="shrink-0">New entries appear at the top</span>
        </footer>
      </Card>

      <ConfirmDialog
        open={clearOpen}
        onClose={() => setClearOpen(false)}
        onConfirm={() => void clearLogs()}
        title="Clear Console Logs"
        message="Clear persisted runtime console logs? New lines keep streaming afterwards."
        danger
        confirmLabel="Clear"
      />
    </>
  );
}

// ── Main page — unified split view ──────────────────────────────────────────

export function ConsoleLogPage() {
  return (
    <div className="dashboard-page flex min-h-0 flex-1 flex-col gap-3 overflow-hidden pt-2 sm:pt-0">
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden">
        <ConsoleLogTab />
      </div>
    </div>
  );
}
