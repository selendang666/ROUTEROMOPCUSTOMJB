#!/usr/bin/env bun
export {};
/**
 * WG Pool Bench — 10 vs 50 tunnels memory simulation.
 * No real WireGuard tunnels needed — uses per-tunnel model from TUNING_1GB.md + gvisor report.
 * Outputs JSON to stdout and writes local/wg-50-bench.json for plan gate.
 */

const PER_TUNNEL_UNTUNED_MB = 10;
const PER_TUNNEL_TUNED_MB = 5;
const GO_RUNTIME_MB = 40;
const OHMYOMOP_ROUTER_MB = 150;
const OS_MB = 80;

function estimate(tunnels: number, tuned: boolean): number {
  const per = tuned ? PER_TUNNEL_TUNED_MB : PER_TUNNEL_UNTUNED_MB;
  return tunnels * per + GO_RUNTIME_MB + OHMYOMOP_ROUTER_MB + OS_MB;
}

const report = {
  generatedAt: new Date().toISOString(),
  tuned: {
    perTunnelMB: PER_TUNNEL_TUNED_MB,
    goRuntimeMB: GO_RUNTIME_MB,
    ohMyOmopRouterMB: OHMYOMOP_ROUTER_MB,
    osMB: OS_MB,
    ten: { tunnels: 10, totalMB: estimate(10, true), headroom1GB: 1024 - estimate(10, true) },
    fifty: { tunnels: 50, totalMB: estimate(50, true), headroom1GB: 1024 - estimate(50, true), gate: estimate(50, true) < 650 ? "PASS <650MB" : "FAIL" },
  },
  untuned: {
    perTunnelMB: PER_TUNNEL_UNTUNED_MB,
    ten: { tunnels: 10, totalMB: estimate(10, false) },
    fifty: { tunnels: 50, totalMB: estimate(50, false), gate: estimate(50, false) < 650 ? "PASS" : "FAIL — needs tuning" },
  },
  tuningApplied: ["single-port SOCKS5", "MTU 1280 buffer 16KB", "MaxConcurrency 20", "GOMEMLIMIT 800MiB GOGC 50", "stagger 100ms", "shared gvisor pool"],
};

await Bun.write("local/wg-50-bench.json", JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
