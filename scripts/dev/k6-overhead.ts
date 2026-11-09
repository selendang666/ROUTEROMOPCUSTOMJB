#!/usr/bin/env bun
/**
 * Reproducible overhead load scenario.
 * Sends bounded POST /v1/chat/completions requests and snapshots
 * GET /health/overhead at start/end so regressions are visible.
 *
 * Usage:
 *   bun scripts/k6-overhead.ts --url http://127.0.0.1:12800 --key $PROXY_API_KEY --rps 50 --duration 60
 */

type Args = { url: string; key: string; rps: number; duration: number };

function parseArgs(): Args {
  const argv = new Map<string, string>();
  for (let i = 2; i < process.argv.length; i += 1) {
    const raw = process.argv[i];
    if (raw === undefined) continue;
    const [name, value] = raw.split("=", 2);
    if (name !== undefined && value !== undefined) argv.set(name.replace(/^--/, ""), value);
    else if (raw.startsWith("--")) argv.set(raw.slice(2), String(process.argv[++i] ?? ""));
  }
  return {
    url: argv.get("url") ?? Bun.env.PUBLIC_ORIGIN ?? "http://127.0.0.1:12800",
    key: argv.get("key") ?? Bun.env.PROXY_API_KEY ?? "",
    rps: Number(argv.get("rps") ?? 20),
    duration: Number(argv.get("duration") ?? 30),
  };
}

async function overheadSnapshot(url: string, key: string): Promise<unknown> {
  const res = await fetch(`${url.replace(/\/+$/, "")}/health/overhead`, { headers: { "x-api-key": key } });
  if (!res.ok) throw new Error(`overhead snapshot failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function run(): Promise<void> {
  const args = parseArgs();
  if (!args.key) throw new Error("Missing --key (PROXY_API_KEY) for /health/overhead and proxy requests.");
  const rps = Math.max(1, Math.min(500, Math.floor(args.rps)));
  const durationMs = Math.max(5_000, Math.floor(args.duration * 1_000));
  const intervalMs = 1_000 / rps;
  const payload = JSON.stringify({ model: "openai/gpt-4o-mini", messages: [{ role: "user", content: [{ type: "text", text: "ping" }] }], stream: false });
  let sent = 0;
  let failed = 0;
  const errors = new Map<string, number>();

  console.log(`[k6-overhead] ${rps} rps for ${Math.round(durationMs / 1000)}s -> ${args.url}`);
  const before = await overheadSnapshot(args.url, args.key);
  const startedAt = performance.now();
  const deadline = startedAt + durationMs;

  while (performance.now() < deadline) {
    const tick = performance.now();
    const batch: Promise<void>[] = [];
    for (let i = 0; i < 1 && performance.now() < deadline; i += 1) {
      batch.push(
        fetch(`${args.url.replace(/\/+$/, "")}/v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": args.key },
          body: payload,
        })
          .then(async (res) => {
            sent += 1;
            if (!res.ok) {
              failed += 1;
              const key = `${res.status}`;
              errors.set(key, (errors.get(key) ?? 0) + 1);
              await res.text().catch(() => {});
            } else {
              await res.text().catch(() => {});
            }
          })
          .catch((error: unknown) => {
            sent += 1;
            failed += 1;
            const key = error instanceof Error ? error.message.slice(0, 80) : String(error).slice(0, 80);
            errors.set(key, (errors.get(key) ?? 0) + 1);
          }),
      );
    }
    await Promise.all(batch);
    const elapsed = performance.now() - tick;
    if (elapsed < intervalMs) await Bun.sleep(intervalMs - elapsed);
  }

  const after = await overheadSnapshot(args.url, args.key);
  console.log(JSON.stringify({ sent, failed, errors: Object.fromEntries(errors), rps, durationS: Math.round(durationMs / 1000), before, after }, null, 2));
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
