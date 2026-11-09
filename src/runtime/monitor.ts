/**
 * Monitor — read-only VPS and agent-service status for the console.
 * All commands are fixed allowlists; no caller input reaches the shell.
 * Every probe is time-bounded and failure-tolerant (a dead service reports
 * `unknown`, never throws).
 */

import { loadavg, totalmem, freemem, uptime } from "node:os";

/** Systemd user services shown on the monitor page. */
const MONITORED_SERVICES = [
  { id: "ohmyomop-router", unit: "ohmyomop-router.service", label: "Oh My Omop - Router" },
  { id: "hermes-gateway", unit: "hermes-gateway.service", label: "Hermes gateway" },
  { id: "hermes-serve", unit: "hermes-serve.service", label: "Hermes dashboard" },
  { id: "cloudflared-router", unit: "cloudflared-router.service", label: "Cloudflare tunnel" },
  { id: "opencode-web", unit: "opencode-web.service", label: "OpenCode web" },
] as const;

/** Status of one monitored service. */
export interface MonitoredService {
  readonly id: string;
  readonly unit: string;
  readonly label: string;
  readonly active: string;
  readonly sub: string | null;
}

/** VPS resource snapshot. */
export interface VpsStats {
  readonly load1: number;
  readonly load5: number;
  readonly load15: number;
  readonly memTotalMb: number;
  readonly memFreeMb: number;
  readonly memUsedPct: number;
  readonly uptimeSec: number;
  readonly diskUsedPct: number | null;
}

/** Full monitor payload. */
export interface MonitorStatus {
  readonly at: string;
  readonly services: readonly MonitoredService[];
  readonly vps: VpsStats;
}

/**
 * Runs one command with a timeout, returning trimmed stdout or null.
 * @param args Fixed argv, never caller-controlled.
 */
function runSync(args: readonly string[], timeoutMs: number): string | null {
  try {
    const proc = Bun.spawnSync([...args], { stdout: "pipe", stderr: "ignore", timeout: timeoutMs });
    if (proc.exitCode !== 0) return null;
    return new TextDecoder().decode(proc.stdout).trim();
  } catch {
    return null;
  }
}

/**
 * Probes one systemd user unit for active/sub state.
 * @param unit Fixed unit name from the allowlist.
 */
function probeService(id: string, unit: string, label: string): MonitoredService {
  const active = runSync(["systemctl", "--user", "is-active", unit], 5_000) ?? "unknown";
  const sub = runSync(["systemctl", "--user", "show", unit, "--property=SubState", "--value"], 5_000);
  return { id, unit, label, active, sub };
}

/**
 * Collects the read-only monitor payload: service states + VPS stats.
 * @returns Monitor status; never throws.
 */
export function getMonitorStatus(): MonitorStatus {
  const [load1 = 0, load5 = 0, load15 = 0] = loadavg();
  const total = totalmem();
  const free = freemem();
  const df = runSync(["df", "--output=pcent", "/"], 5_000);
  const diskMatch = df === null ? null : /(\d+)%/.exec(df);
  return {
    at: new Date().toISOString(),
    services: MONITORED_SERVICES.map((s) => probeService(s.id, s.unit, s.label)),
    vps: {
      load1,
      load5,
      load15,
      memTotalMb: Math.round(total / 1_048_576),
      memFreeMb: Math.round(free / 1_048_576),
      memUsedPct: total > 0 ? Math.round(((total - free) / total) * 100) : 0,
      uptimeSec: Math.floor(uptime()),
      diskUsedPct: diskMatch?.[1] === undefined ? null : Number(diskMatch[1]),
    },
  };
}
