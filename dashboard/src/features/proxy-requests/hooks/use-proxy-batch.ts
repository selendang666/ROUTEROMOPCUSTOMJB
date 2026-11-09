/**
 * Parses proxy URLs in bulk and detects relay.
 * @param input - multiline proxy URLs
 * @returns parsed hosts
 */
export function parseProxyUrls(input: string): Array<{ host: string; port: number; protocol: string }> {
  return input
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        const url = new URL(line.includes("://") ? line : `http://${line}`);
        return { host: url.hostname, port: Number(url.port) || 80, protocol: url.protocol.replace(":", "") };
      } catch {
        return null;
      }
    })
    .filter((v): v is { host: string; port: number; protocol: string } => Boolean(v));
}

/** Detects relay via .vercel.app heuristic. @param host - hostname @returns true if relay */
export function detectIsRelay(host: string): boolean {
  return host.endsWith(".vercel.app");
}
