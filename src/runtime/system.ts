import { arch, cpus, freemem, platform, totalmem } from "node:os";
import { execSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";

export interface HealthMetrics {
  readonly memoryUsedMb: number;
  readonly memorySystemUsedMb: number;
  readonly memoryTotalMb: number;
  readonly cpuPercent: number;
  readonly heapUsedMb: number;
  readonly heapTotalMb: number;
  readonly externalMb: number;
  readonly arrayBuffersMb: number;
  readonly coreCount: number;
  readonly cpuModel: string;
  readonly pid: number;
  readonly uptimeSeconds: number;
  readonly platform: string;
  readonly arch: string;
  readonly bunVersion: string;
  readonly wireguardClientMemoryMb: number | null;
}

const WIREGUARD_TTL_MS = 10_000;
const CPU_INFO = cpus();
let lastCpuUsage = process.cpuUsage();
let lastCpuSampleAt = performance.now();
let cachedWireguard: { readonly value: number | null; readonly at: number } | null = null;

function sampleCpuPercent(): number {
  const now = performance.now();
  const usage = process.cpuUsage();
  const elapsedMs = now - lastCpuSampleAt;
  const deltaCpuUs = usage.user - lastCpuUsage.user + (usage.system - lastCpuUsage.system);
  lastCpuUsage = usage;
  lastCpuSampleAt = now;
  if (elapsedMs <= 0) return 0;
  const coreCount = Math.max(1, CPU_INFO.length);
  const percent = ((deltaCpuUs / 1000) / elapsedMs) * 100 / coreCount;
  return Math.min(100, Math.max(0, Math.round(percent * 10) / 10));
}

function wireguardClientMemoryMbRaw(): number | null {
  try {
    if (platform() === "win32") {
      const output = execSync(
        'powershell -NoProfile -Command "$p=Get-Process -Name wireproxy -ErrorAction SilentlyContinue; if ($p) {[math]::Round((($p | Measure-Object WorkingSet64 -Sum).Sum)/1MB,1)}"',
        { encoding: "utf8", timeout: 2_000 },
      ).trim();
      const value = Number(output);
      return Number.isFinite(value) && value > 0 ? value : null;
    }
    if (platform() === "linux") {
      let totalPages = 0;
      for (const pid of readdirSync("/proc")) {
        if (!/^\d+$/.test(pid)) continue;
        const command = readFileSync(`/proc/${pid}/comm`, "utf8").trim();
        if (command !== "wireproxy") continue;
        const statm = readFileSync(`/proc/${pid}/statm`, "utf8").trim().split(/\s+/);
        const residentPages = Number(statm[1]);
        if (Number.isFinite(residentPages)) totalPages += residentPages;
      }
      const value = (totalPages * 4096) / 1024 / 1024;
      return value > 0 ? Math.round(value * 10) / 10 : null;
    }
  } catch {
    // Process metrics are optional; the dashboard shows unavailable when unsupported.
  }
  return null;
}

function wireguardClientMemoryMb(): number | null {
  const now = performance.now();
  if (cachedWireguard !== null && now - cachedWireguard.at < WIREGUARD_TTL_MS) return cachedWireguard.value;
  const value = wireguardClientMemoryMbRaw();
  cachedWireguard = { value, at: now };
  return value;
}

/**
 * Returns live process, system, CPU, and WireGuard metrics.
 *
 * @returns current health metrics for the console dashboard
 */
export function getSystemMetrics(): HealthMetrics {
  const memory = process.memoryUsage();
  const total = totalmem();
  const cpuInfo = CPU_INFO[0];
  return {
    memoryUsedMb: memory.rss / 1024 / 1024,
    memorySystemUsedMb: Math.max(0, total - freemem()) / 1024 / 1024,
    memoryTotalMb: total / 1024 / 1024,
    cpuPercent: sampleCpuPercent(),
    heapUsedMb: memory.heapUsed / 1024 / 1024,
    heapTotalMb: memory.heapTotal / 1024 / 1024,
    externalMb: memory.external / 1024 / 1024,
    arrayBuffersMb: memory.arrayBuffers / 1024 / 1024,
    coreCount: CPU_INFO.length,
    cpuModel: cpuInfo?.model ?? "",
    pid: process.pid,
    uptimeSeconds: Math.floor(process.uptime()),
    platform: platform(),
    arch: arch(),
    bunVersion: typeof Bun !== "undefined" ? Bun.version : process.version,
    wireguardClientMemoryMb: wireguardClientMemoryMb(),
  };
}
