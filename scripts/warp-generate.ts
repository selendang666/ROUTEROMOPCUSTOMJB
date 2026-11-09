#!/usr/bin/env bun
/**
 * Warp Generator (Bun, cross-OS) — simpler than wgcf, based on lanrat/wireguard-warp-generator.
 *
 * Generates WireGuard INI configs for Cloudflare WARP via direct API call:
 *   bun run warp-generate --count 5 --out ./pool
 *   bun run warp-generate --count 1 > warp.conf
 *
 * Cross-platform: pure JS X25519 via @noble/curves (no wg binary), fetch via Bun.
 * Universal output: INI compatible with vendor/wireproxy ParseConfig and wireguard-go pool.
 */

import { x25519 } from "@noble/curves/ed25519";

const WARP_API_URL = Bun.env.WARP_API_URL ?? "https://api.cloudflareclient.com/v0a737/reg";
const WARP_DNS = Bun.env.WARP_DNS ?? "1.1.1.1, 1.0.0.1, 2606:4700:4700::1111, 2606:4700:4700::1001";
const WARP_MTU = Number(Bun.env.WARP_MTU ?? 1280);
const WARP_ALLOWED_IPS = Bun.env.WARP_ALLOWED_IPS ?? "0.0.0.0/0, ::/0";
const WARP_DEVICE_TYPE = Bun.env.WARP_DEVICE_TYPE ?? "Linux";
const WARP_LOCALE = Bun.env.WARP_LOCALE ?? "en_US";
const WARP_PERSISTENT_KEEPALIVE = Number(Bun.env.WARP_PERSISTENT_KEEPALIVE ?? 0);
const WARP_LISTEN_PORT = Number(Bun.env.WARP_LISTEN_PORT ?? 0);

interface Args {
  count: number;
  outDir: string | null;
  stdout: boolean;
  verbose: boolean;
}

function parseArgs(): Args {
  const args = Bun.argv.slice(2);
  let count = 1;
  let outDir: string | null = null;
  let verbose = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === "--count" || arg === "-c") count = Math.max(1, Math.min(50, Number(args[++i] ?? 1) || 1));
    else if (arg.startsWith("--count=")) count = Math.max(1, Math.min(50, Number(arg.split("=")[1] ?? 1) || 1));
    else if (arg === "--out" || arg === "-o") outDir = args[++i] ?? null;
    else if (arg.startsWith("--out=")) outDir = arg.split("=").slice(1).join("=");
    else if (arg === "--verbose" || arg === "-v") verbose = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(`warp-generate --count 5 --out ./pool
  --count N     number of WARP configs to generate (1-50, default 1)
  --out DIR     output directory (default stdout)
  --verbose     log API response to stderr
  env: WARP_DNS, WARP_MTU, WARP_ALLOWED_IPS, WARP_DEVICE_TYPE`);
      process.exit(0);
    }
  }
  return { count, outDir, stdout: outDir === null, verbose };
}

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

async function generateWarpConfig(verbose: boolean): Promise<string> {
  const priv = x25519.utils.randomPrivateKey();
  const pub = x25519.getPublicKey(priv);
  const privB64 = b64(priv);
  const pubB64 = b64(pub);
  const payload = JSON.stringify({
    key: pubB64,
    install_id: "",
    warp_enabled: true,
    tos: new Date().toISOString(),
    type: WARP_DEVICE_TYPE,
    locale: WARP_LOCALE,
  });
  if (verbose) console.error(`[warp] POST ${WARP_API_URL} pub=${pubB64.slice(0, 12)}...`);
  const res = await fetch(WARP_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: payload,
  });
  if (!res.ok) throw new Error(`WARP API ${res.status} ${await res.text()}`);
  const data = (await res.json()) as {
    config: { peers: Array<{ public_key: string; endpoint: { host: string } }>; interface: { addresses: { v4: string; v6: string } } };
  };
  if (verbose) console.error(`[warp] response peers=${data.config.peers.length}`);
  const peer = data.config.peers[0];
  if (!peer) throw new Error("WARP API missing peer");
  const v4 = data.config.interface.addresses.v4;
  const v6 = data.config.interface.addresses.v6;
  if (!v4) throw new Error("WARP API missing v4 address");
  const endpoint = peer.endpoint.host;
  if (!endpoint) throw new Error("WARP API missing endpoint");
  let address = `${v4}/32`;
  if (v6) address += `, ${v6}/128`;
  const listenLine = WARP_LISTEN_PORT !== 0 ? `ListenPort = ${WARP_LISTEN_PORT}\n` : "";
  const keepaliveLine = WARP_PERSISTENT_KEEPALIVE !== 0 ? `PersistentKeepalive = ${WARP_PERSISTENT_KEEPALIVE}\n` : "";
  return `[Interface]
PrivateKey = ${privB64}
Address = ${address}
DNS = ${WARP_DNS}
MTU = ${WARP_MTU}
${listenLine}[Peer]
PublicKey = ${peer.public_key}
AllowedIPs = ${WARP_ALLOWED_IPS}
Endpoint = ${endpoint}
${keepaliveLine}`.trimEnd() + "\n";
}

async function main(): Promise<void> {
  const { count, outDir, stdout, verbose } = parseArgs();
  if (outDir !== null) await Bun.$`mkdir -p ${outDir}`.quiet();
  for (let i = 0; i < count; i += 1) {
    const ini = await generateWarpConfig(verbose);
    if (stdout) {
      process.stdout.write(ini + (count > 1 && i < count - 1 ? "\n" : ""));
    } else {
      const file = `${outDir!.replace(/\/+$/, "")}/warp-${String(i + 1).padStart(2, "0")}.conf`;
      await Bun.write(file, ini);
      console.error(`[warp] wrote ${file}`);
    }
    if (i < count - 1) await Bun.sleep(200);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
