#!/usr/bin/env bun
/**
 * elysia-aot-bench — Isolated Elysia 2 AOT / precompile benchmark.
 *
 * Compares three Elysia 2.0.0-beta.6 configurations on a representative
 * route set that mirrors Oh My Omop - Router's public, console, and share routers:
 *
 *   1. default   — runtime JIT (current production: `new Elysia()`)
 *   2. precompile — eager compile at startup (`{ precompile: true }`)
 *   3. aot-build  — Bun.build with `elysia/plugin/aot/bun` AOT plugin
 *
 * Metrics: startup, first request, warm p50/p95/p99, RSS/heap/external/
 * arrayBuffers, and bundle size (AOT build only).
 *
 * Usage:
 *   bun run scripts/elysia-aot-bench.ts              # run all three
 *   bun run scripts/elysia-aot-bench.ts -- --help     # help
 *   bun run scripts/elysia-aot-bench.ts -- --dry-run  # verify setup only
 *   bun run scripts/elysia-aot-bench.ts -- --iterations 500
 *   bun run scripts/elysia-aot-bench.ts -- --only default
 *   bun run scripts/elysia-aot-bench.ts -- --only precompile
 *   bun run scripts/elysia-aot-bench.ts -- --only aot-build
 *
 * Does NOT modify production code, build scripts, or application.ts.
 */

import { Elysia } from "elysia";
import path from "node:path";
import fs from "node:fs";

// ── Types ──────────────────────────────────────────────────────────────────

interface MemorySnapshot {
  rss: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
  arrayBuffers: number;
}

interface LatencyStats {
  min: number;
  max: number;
  p50: number;
  p95: number;
  p99: number;
  mean: number;
  count: number;
  errors: number;
}

interface VariantResult {
  name: string;
  startupMs: number;
  firstRequestMs: number;
  warmLatency: LatencyStats;
  memoryBefore: MemorySnapshot;
  memoryAfter: MemorySnapshot;
  bundleSizeBytes?: number;
  bundleBuildMs?: number;
  supported: boolean;
  unsupportedReason?: string;
}

interface Args {
  iterations: number;
  concurrency: number;
  only: string | null;
  dryRun: boolean;
  help: boolean;
}

interface BenchRoute {
  readonly method: "GET" | "POST";
  readonly path: string;
}

// ── Constants ──────────────────────────────────────────────────────────────

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const AOT_OUTDIR = path.join(REPO_ROOT, ".tmp-aot-bench");
const AOT_ENTRY = path.join(AOT_OUTDIR, "bench-app.ts");

/** Representative route paths matching Oh My Omop - Router's surface area. */
const BENCH_ROUTES: readonly BenchRoute[] = [
  { method: "GET", path: "/health" },
  { method: "GET", path: "/v1/models" },
  { method: "POST", path: "/v1/chat/completions" },
  { method: "POST", path: "/v1/responses" },
  { method: "POST", path: "/v1/messages" },
  { method: "GET", path: "/share/test-token" },
  { method: "GET", path: "/share/test-token/data" },
  { method: "GET", path: "/share/test-token/setup" },
  { method: "GET", path: "/console/api/overview" },
  { method: "GET", path: "/console/api/providers" },
  { method: "GET", path: "/console/api/models" },
  { method: "GET", path: "/console/api/api-keys" },
  { method: "POST", path: "/console/api/backup/export" },
  { method: "GET", path: "/console/api/telemetry/overview" },
  { method: "GET", path: "/console/api/telemetry/providers" },
  { method: "GET", path: "/console/api/telemetry/top-ips" },
  { method: "GET", path: "/metrics" },
];

// ── Elysia extended interface for benchmark hooks ──────────────────────────
// The benchmark app uses afterHandle/get/post/all which are on the Elysia
// class but the generic type parameters lose the chainable return type.
// We cast through a minimal interface to avoid `any`.

interface ElysiaApp {
  afterHandle(fn: (ctx: { response: Response }) => void): ElysiaApp;
  get(path: string, handler: (ctx: { params: Record<string, string>; request: Request }) => Response | string): ElysiaApp;
  post(path: string, handler: (ctx: { params: Record<string, string>; request: Request }) => Response | string): ElysiaApp;
  all(path: string, handler: () => Response): ElysiaApp;
  fetch: (request: Request) => Response | Promise<Response>;
}

// ── Arg parsing ────────────────────────────────────────────────────────────

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const args: Args = { iterations: 200, concurrency: 1, only: null, dryRun: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--help": case "-h": args.help = true; break;
      case "--dry-run": args.dryRun = true; break;
      case "--iterations": case "-n": args.iterations = parseInt(argv[++i] ?? "200", 10); break;
      case "--concurrency": case "-c": args.concurrency = parseInt(argv[++i] ?? "1", 10); break;
      case "--only": args.only = argv[++i] ?? null; break;
    }
  }
  return args;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function memorySnapshot(): MemorySnapshot {
  const m = process.memoryUsage();
  return { rss: m.rss, heapUsed: m.heapUsed, heapTotal: m.heapTotal, external: m.external, arrayBuffers: m.arrayBuffers };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

function formatMs(ms: number): string {
  return ms < 1 ? `${(ms * 1000).toFixed(0)} µs` : `${ms.toFixed(2)} ms`;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function computeStats(latencies: number[], errors: number): LatencyStats {
  if (latencies.length === 0) return { min: 0, max: 0, p50: 0, p95: 0, p99: 0, mean: 0, count: 0, errors };
  const sorted = [...latencies].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    mean: sum / sorted.length,
    count: sorted.length,
    errors,
  };
}

function diffMemory(before: MemorySnapshot, after: MemorySnapshot): string {
  const d = (label: string, a: number, b: number) => {
    const delta = b - a;
    const sign = delta >= 0 ? "+" : "";
    return `  ${label}: ${formatBytes(a)} → ${formatBytes(b)} (${sign}${formatBytes(delta)})`;
  };
  return [
    d("RSS", before.rss, after.rss),
    d("HeapUsed", before.heapUsed, after.heapUsed),
    d("External", before.external, after.external),
    d("ArrayBuffers", before.arrayBuffers, after.arrayBuffers),
  ].join("\n");
}

// ── Representative Elysia app factory ──────────────────────────────────────

/**
 * Creates an Elysia app with a route set representative of Oh My Omop - Router's
 * public, console, and share routers — same count, nesting depth, middleware
 * chain (afterHandle security headers, guards), and wildcard fallback.
 *
 * This isolates the benchmark from PostgreSQL/Redis/provider dependencies
 * while exercising the same Elysia compilation surface.
 */
function createBenchApp(config?: { precompile?: boolean }): Elysia {
  const app = new Elysia(config) as unknown as ElysiaApp;

  // afterHandle — mirrors application.ts security headers
  app.afterHandle((ctx) => {
    if (ctx.response instanceof Response && !ctx.response.headers.has("x-content-type-options")) {
      ctx.response.headers.set("x-content-type-options", "nosniff");
      ctx.response.headers.set("x-frame-options", "DENY");
    }
  });

  // Health — mirrors bootstrap health route
  app.get("/health", () => new Response(JSON.stringify({ status: "ok" }), {
    headers: { "content-type": "application/json" },
  }));

  // Public API routes — mirrors createPublicRouter
  app.get("/v1/models", () => new Response(JSON.stringify({ object: "list", data: [] }), {
    headers: { "content-type": "application/json" },
  }));

  app.post("/v1/chat/completions", () => new Response(JSON.stringify({ id: "bench", object: "chat.completion", choices: [] }), {
    headers: { "content-type": "application/json" },
  }));

  app.post("/v1/responses", () => new Response(JSON.stringify({ id: "bench", object: "response", output: [] }), {
    headers: { "content-type": "application/json" },
  }));

  app.post("/v1/messages", () => new Response(JSON.stringify({ id: "bench", type: "message", content: [] }), {
    headers: { "content-type": "application/json" },
  }));

  // Share routes — mirrors createShareRouter
  app.get("/share/:token", (ctx) => new Response(JSON.stringify({ token: ctx.params.token }), {
    headers: { "content-type": "application/json" },
  }));

  app.get("/share/:token/data", (ctx) => new Response(JSON.stringify({ token: ctx.params.token, models: [] }), {
    headers: { "content-type": "application/json" },
  }));

  app.get("/share/:token/setup", (ctx) => new Response(JSON.stringify({ token: ctx.params.token, setup: true }), {
    headers: { "content-type": "application/json" },
  }));

  // Console API routes — mirrors createConsoleRouter
  const consoleRoutes = [
    "/console/api/overview",
    "/console/api/providers",
    "/console/api/models",
    "/console/api/api-keys",
    "/console/api/telemetry/overview",
    "/console/api/telemetry/providers",
    "/console/api/telemetry/top-ips",
  ];
  for (const route of consoleRoutes) {
    app.get(route, () => new Response(JSON.stringify({ ok: true }), {
      headers: { "content-type": "application/json" },
    }));
  }

  app.post("/console/api/backup/export", () => new Response(JSON.stringify({ version: 1, tables: {} }), {
    headers: { "content-type": "application/json" },
  }));

  // Metrics — mirrors overhead prometheus route
  app.get("/metrics", () => new Response("# HELP bench metrics\n", {
    headers: { "content-type": "text/plain" },
  }));

  // Wildcard 404 — mirrors application.ts catch-all
  app.all("/*", () => new Response(JSON.stringify({ error: { type: "error", code: "not_found" } }), {
    status: 404,
    headers: { "content-type": "application/json" },
  }));

  return app as unknown as Elysia;
}

// ── Benchmark runner ───────────────────────────────────────────────────────

async function benchVariant(
  name: string,
  createApp: () => Elysia | Promise<Elysia>,
  iterations: number,
  _concurrency: number,
): Promise<VariantResult> {
  const memBefore = memorySnapshot();

  // Startup
  const t0 = performance.now();
  const app = await createApp();
  const startupMs = performance.now() - t0;

  // First request (cold)
  const server = Bun.serve({ port: 0, fetch: app.fetch });
  const baseUrl = server.url.toString();

  const firstReqStart = performance.now();
  const firstRes = await fetch(`${baseUrl}health`);
  await firstRes.text();
  const firstRequestMs = performance.now() - firstReqStart;

  // Warm latency — cycle through representative routes
  const latencies: number[] = [];
  let errors = 0;

  for (let i = 0; i < iterations; i++) {
    const route = BENCH_ROUTES[i % BENCH_ROUTES.length];
    const url = `${baseUrl}${route.path.slice(1)}`;
    const t = performance.now();
    try {
      const res = await fetch(url, {
        method: route.method,
        headers: route.method === "POST" ? { "content-type": "application/json" } : undefined,
        body: route.method === "POST" ? "{}" : undefined,
      });
      await res.text();
      if (!res.ok) errors++;
    } catch {
      errors++;
    }
    latencies.push(performance.now() - t);
  }

  server.stop();
  const memAfter = memorySnapshot();

  return {
    name,
    startupMs,
    firstRequestMs,
    warmLatency: computeStats(latencies, errors),
    memoryBefore: memBefore,
    memoryAfter: memAfter,
    supported: true,
  };
}

// ── AOT build variant ─────────────────────────────────────────────────────

/** Source for the standalone AOT benchmark entry file. */
const AOT_ENTRY_SOURCE = `import { Elysia } from "elysia";

const app = new Elysia();

app.afterHandle((ctx: { response: Response }) => {
    if (ctx.response instanceof Response && !ctx.response.headers.has("x-content-type-options")) {
      ctx.response.headers.set("x-content-type-options", "nosniff");
      ctx.response.headers.set("x-frame-options", "DENY");
    }
  });

app.get("/health", () => new Response(JSON.stringify({ status: "ok" }), {
    headers: { "content-type": "application/json" },
  }));

app.get("/v1/models", () => new Response(JSON.stringify({ object: "list", data: [] }), {
    headers: { "content-type": "application/json" },
  }));

app.post("/v1/chat/completions", () => new Response(JSON.stringify({ id: "bench", object: "chat.completion", choices: [] }), {
    headers: { "content-type": "application/json" },
  }));

app.post("/v1/responses", () => new Response(JSON.stringify({ id: "bench", object: "response", output: [] }), {
    headers: { "content-type": "application/json" },
  }));

app.post("/v1/messages", () => new Response(JSON.stringify({ id: "bench", type: "message", content: [] }), {
    headers: { "content-type": "application/json" },
  }));

app.get("/share/:token", (ctx: { params: { token: string } }) => new Response(JSON.stringify({ token: ctx.params.token }), {
    headers: { "content-type": "application/json" },
  }));

app.get("/share/:token/data", (ctx: { params: { token: string } }) => new Response(JSON.stringify({ token: ctx.params.token, models: [] }), {
    headers: { "content-type": "application/json" },
  }));

app.get("/share/:token/setup", (ctx: { params: { token: string } }) => new Response(JSON.stringify({ token: ctx.params.token, setup: true }), {
    headers: { "content-type": "application/json" },
  }));

const consoleRoutes = [
    "/console/api/overview",
    "/console/api/providers",
    "/console/api/models",
    "/console/api/api-keys",
    "/console/api/telemetry/overview",
    "/console/api/telemetry/providers",
    "/console/api/telemetry/top-ips",
  ];
for (const route of consoleRoutes) {
  app.get(route, () => new Response(JSON.stringify({ ok: true }), {
      headers: { "content-type": "application/json" },
    }));
}

app.post("/console/api/backup/export", () => new Response(JSON.stringify({ version: 1, tables: {} }), {
    headers: { "content-type": "application/json" },
  }));

app.get("/metrics", () => new Response("# HELP bench metrics\\n", {
    headers: { "content-type": "text/plain" },
  }));

app.all("/*", () => new Response(JSON.stringify({ error: { type: "error", code: "not_found" } }), {
    status: 404,
    headers: { "content-type": "application/json" },
  }));

export { app };
`;

type AotBuildResult =
  | { ok: true; bundlePath: string; buildMs: number; sizeBytes: number }
  | { ok: false; reason: string };

async function buildAotBundle(): Promise<AotBuildResult> {
  // Ensure output directory exists
  fs.mkdirSync(path.join(AOT_OUTDIR, "out"), { recursive: true });
  fs.writeFileSync(AOT_ENTRY, AOT_ENTRY_SOURCE);

  // Import the AOT plugin — genuinely runtime-selected: we are testing
  // whether this installed version's plugin can build this app.
  let aotPlugin: (entry: string, options?: unknown) => { name: string; setup: (build: unknown) => Promise<void> };
  try {
    const mod = await import("elysia/plugin/aot/bun");
    aotPlugin = mod.aot as typeof aotPlugin;
  } catch (err) {
    return { ok: false, reason: `Cannot import elysia/plugin/aot/bun: ${String(err)}` };
  }

  // Build with AOT plugin
  const t0 = performance.now();
  try {
    const result = await Bun.build({
      entrypoints: [AOT_ENTRY],
      outdir: path.join(AOT_OUTDIR, "out"),
      plugins: [aotPlugin(AOT_ENTRY)],
      target: "bun",
    });

    const buildMs = performance.now() - t0;

    if (!result.success) {
      const logs = result.logs.map((l) => l.message).join("\n");
      return { ok: false, reason: `AOT build failed:\n${logs}` };
    }

    const outputs = result.outputs;
    if (outputs.length === 0) {
      return { ok: false, reason: "AOT build produced no outputs" };
    }

    const outPath = outputs[0].path;
    const sizeBytes = outputs[0].size;

    return { ok: true, bundlePath: outPath, buildMs, sizeBytes };
  } catch (err) {
    return { ok: false, reason: `AOT build threw: ${String(err)}` };
  }
}

async function benchAotBuild(iterations: number, _concurrency: number): Promise<VariantResult> {
  const memBefore = memorySnapshot();

  const buildResult = await buildAotBundle();

  if (!buildResult.ok) {
    return {
      name: "aot-build",
      startupMs: 0,
      firstRequestMs: 0,
      warmLatency: computeStats([], 0),
      memoryBefore: memBefore,
      memoryAfter: memBefore,
      supported: false,
      unsupportedReason: buildResult.reason,
    };
  }

  // Import the AOT-built bundle
  const t0 = performance.now();
  let aotApp: Elysia;
  try {
    // AOT entry exports `app` directly (required by elysia-aot plugin)
    const mod = await import(buildResult.bundlePath) as { app: Elysia };
    aotApp = mod.app;
  } catch (err) {
    return {
      name: "aot-build",
      startupMs: 0,
      firstRequestMs: 0,
      warmLatency: computeStats([], 0),
      memoryBefore: memBefore,
      memoryAfter: memBefore,
      bundleSizeBytes: buildResult.sizeBytes,
      bundleBuildMs: buildResult.buildMs,
      supported: false,
      unsupportedReason: `Cannot import AOT bundle: ${String(err)}`,
    };
  }

  const startupMs = performance.now() - t0;

  const server = Bun.serve({ port: 0, fetch: aotApp.fetch });
  const baseUrl = server.url.toString();

  const firstReqStart = performance.now();
  const firstRes = await fetch(`${baseUrl}health`);
  await firstRes.text();
  const firstRequestMs = performance.now() - firstReqStart;

  const latencies: number[] = [];
  let errors = 0;

  for (let i = 0; i < iterations; i++) {
    const route = BENCH_ROUTES[i % BENCH_ROUTES.length];
    const url = `${baseUrl}${route.path.slice(1)}`;
    const t = performance.now();
    try {
      const res = await fetch(url, {
        method: route.method,
        headers: route.method === "POST" ? { "content-type": "application/json" } : undefined,
        body: route.method === "POST" ? "{}" : undefined,
      });
      await res.text();
      if (!res.ok) errors++;
    } catch {
      errors++;
    }
    latencies.push(performance.now() - t);
  }

  server.stop();
  const memAfter = memorySnapshot();

  return {
    name: "aot-build",
    startupMs,
    firstRequestMs,
    warmLatency: computeStats(latencies, errors),
    memoryBefore: memBefore,
    memoryAfter: memAfter,
    bundleSizeBytes: buildResult.sizeBytes,
    bundleBuildMs: buildResult.buildMs,
    supported: true,
  };
}

// ── Help ───────────────────────────────────────────────────────────────────

function printHelp(): void {
  console.log(`
elysia-aot-bench — Elysia 2 AOT / precompile benchmark

Usage:
  bun run scripts/elysia-aot-bench.ts [options]

Options:
  --help, -h            Show this help
  --dry-run             Verify setup without running benchmarks
  --iterations, -n N    Requests per variant (default: 200)
  --concurrency, -c N   Concurrent requests (default: 1)
  --only VARIANT        Run only: default | precompile | aot-build

Variants:
  default       Runtime JIT — current production: new Elysia()
  precompile    Eager compile — { precompile: true }
  aot-build     Bun.build with elysia/plugin/aot/bun AOT plugin

Output:
  Startup time, first-request latency, warm p50/p95/p99,
  RSS/heap/external/arrayBuffers delta, bundle size (AOT only).
`);
}

// ── Dry run ────────────────────────────────────────────────────────────────

async function dryRun(): Promise<void> {
  console.log("=== Elysia AOT Benchmark — Dry Run ===\n");

  // Check Elysia version
  const elysiaPkgRaw: unknown = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "node_modules/elysia/package.json"), "utf-8"));
  const elysiaVersion = elysiaPkgRaw && typeof elysiaPkgRaw === "object" && "version" in elysiaPkgRaw
    ? String(elysiaPkgRaw.version)
    : "unknown";
  console.log(`Elysia version: ${elysiaVersion}`);

  // Check precompile support
  try {
    const app = new Elysia({ precompile: true });
    (app as unknown as ElysiaApp).get("/test", () => "ok");
    console.log("✓ precompile: true — accepted by constructor");
  } catch (err) {
    console.log(`✗ precompile: true — rejected: ${String(err)}`);
  }

  // Check AOT plugin import
  try {
    const mod = await import("elysia/plugin/aot/bun");
    console.log(`✓ elysia/plugin/aot/bun — importable, exports: ${Object.keys(mod).join(", ")}`);
  } catch (err) {
    console.log(`✗ elysia/plugin/aot/bun — cannot import: ${String(err)}`);
  }

  // Check Bun.build availability
  console.log(`✓ Bun.build — available (Bun ${Bun.version})`);

  // Test AOT build with a trivial app
  console.log("\n--- AOT build smoke test ---");
  const buildResult = await buildAotBundle();
  if (buildResult.ok) {
    console.log(`✓ AOT build succeeded: ${formatBytes(buildResult.sizeBytes)} in ${formatMs(buildResult.buildMs)}`);
    // Try importing the built bundle
    try {
      const mod = await import(buildResult.bundlePath) as { app: Elysia };
      const app = mod.app;
      const server = Bun.serve({ port: 0, fetch: app.fetch });
      const res = await fetch(`${server.url}health`);
      const body = await res.text();
      server.stop();
      console.log(`✓ AOT bundle serves /health: ${body.substring(0, 80)}`);
    } catch (err) {
      console.log(`✗ AOT bundle import/serve failed: ${String(err)}`);
    }
  } else {
    console.log(`✗ AOT build failed: ${buildResult.reason}`);
  }

  // Cleanup
  try { fs.rmSync(AOT_OUTDIR, { recursive: true, force: true }); } catch {}

  console.log("\n=== Dry run complete ===");
}

// ── Print results ──────────────────────────────────────────────────────────

function printResult(r: VariantResult): void {
  console.log(`\n${"─".repeat(60)}`);
  console.log(`  ${r.name}`);
  console.log(`${"─".repeat(60)}`);

  if (!r.supported) {
    console.log(`  UNSUPPORTED: ${r.unsupportedReason}`);
    return;
  }

  console.log(`  Startup:        ${formatMs(r.startupMs)}`);
  console.log(`  First request:  ${formatMs(r.firstRequestMs)}`);
  console.log(`  Warm latency (${r.warmLatency.count} reqs, ${r.warmLatency.errors} errors):`);
  console.log(`    p50:  ${formatMs(r.warmLatency.p50)}`);
  console.log(`    p95:  ${formatMs(r.warmLatency.p95)}`);
  console.log(`    p99:  ${formatMs(r.warmLatency.p99)}`);
  console.log(`    mean: ${formatMs(r.warmLatency.mean)}`);
  console.log(`    min:  ${formatMs(r.warmLatency.min)}`);
  console.log(`    max:  ${formatMs(r.warmLatency.max)}`);
  console.log(`  Memory delta:`);
  console.log(diffMemory(r.memoryBefore, r.memoryAfter));

  if (r.bundleSizeBytes !== undefined) {
    console.log(`  Bundle size:    ${formatBytes(r.bundleSizeBytes)}`);
  }
  if (r.bundleBuildMs !== undefined) {
    console.log(`  Bundle build:   ${formatMs(r.bundleBuildMs)}`);
  }
}

function printComparison(results: VariantResult[]): void {
  const supported = results.filter((r) => r.supported);
  if (supported.length < 2) return;

  console.log(`\n${"═".repeat(60)}`);
  console.log("  COMPARISON");
  console.log(`${"═".repeat(60)}`);

  const baseline = supported[0];

  const row = (label: string, getter: (r: VariantResult) => number) => {
    const vals = supported.map((r) => formatMs(getter(r)).padEnd(14)).join("");
    console.log(`  ${label.padEnd(14)}${vals}`);
  };

  console.log(`  ${"".padEnd(14)}${supported.map((r) => r.name.padEnd(14)).join("")}`);
  row("startup", (r) => r.startupMs);
  row("first-req", (r) => r.firstRequestMs);
  row("p50", (r) => r.warmLatency.p50);
  row("p95", (r) => r.warmLatency.p95);
  row("p99", (r) => r.warmLatency.p99);
  row("mean", (r) => r.warmLatency.mean);

  // Delta vs baseline
  if (supported.length > 1) {
    console.log(`\n  Delta vs ${baseline.name}:`);
    for (let i = 1; i < supported.length; i++) {
      const r = supported[i];
      const pctStartup = ((r.startupMs - baseline.startupMs) / baseline.startupMs * 100).toFixed(1);
      const pctP50 = ((r.warmLatency.p50 - baseline.warmLatency.p50) / baseline.warmLatency.p50 * 100).toFixed(1);
      const pctP95 = ((r.warmLatency.p95 - baseline.warmLatency.p95) / baseline.warmLatency.p95 * 100).toFixed(1);
      console.log(`    ${r.name}: startup ${pctStartup}%, p50 ${pctP50}%, p95 ${pctP95}%`);
    }
  }
}

// ── Cleanup ────────────────────────────────────────────────────────────────

function cleanup(): void {
  try { fs.rmSync(AOT_OUTDIR, { recursive: true, force: true }); } catch {}
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs();

  if (args.help) {
    printHelp();
    return;
  }

  if (args.dryRun) {
    await dryRun();
    return;
  }

  const pkgRaw: unknown = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "node_modules/elysia/package.json"), "utf-8"));
  const elysiaVersion = pkgRaw && typeof pkgRaw === "object" && "version" in pkgRaw
    ? String(pkgRaw.version)
    : "unknown";

  console.log("=== Elysia 2 AOT / Precompile Benchmark ===");
  console.log(`Iterations: ${args.iterations} | Concurrency: ${args.concurrency}`);
  console.log(`Elysia: ${elysiaVersion}`);
  console.log(`Bun: ${Bun.version}`);
  console.log(`Routes: ${BENCH_ROUTES.length} representative paths\n`);

  const results: VariantResult[] = [];

  // 1. Default (runtime JIT)
  if (!args.only || args.only === "default") {
    console.log("▸ Running: default (runtime JIT)...");
    if (typeof globalThis.gc === "function") globalThis.gc();
    const r = await benchVariant("default", () => createBenchApp(), args.iterations, args.concurrency);
    results.push(r);
    printResult(r);
  }

  // 2. Precompile
  if (!args.only || args.only === "precompile") {
    console.log("▸ Running: precompile...");
    if (typeof globalThis.gc === "function") globalThis.gc();
    const r = await benchVariant("precompile", () => createBenchApp({ precompile: true }), args.iterations, args.concurrency);
    results.push(r);
    printResult(r);
  }

  // 3. AOT build
  if (!args.only || args.only === "aot-build") {
    console.log("▸ Running: aot-build (Bun.build + elysia/plugin/aot/bun)...");
    if (typeof globalThis.gc === "function") globalThis.gc();
    const r = await benchAotBuild(args.iterations, args.concurrency);
    results.push(r);
    printResult(r);
  }

  // Comparison table
  printComparison(results);

  // Cleanup temp build artifacts
  cleanup();

  console.log("\n=== Benchmark complete ===");
}

main().catch((err: unknown) => {
  console.error("Benchmark failed:", err);
  cleanup();
  process.exitCode = 1;
});
