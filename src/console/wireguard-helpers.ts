export const wireguardProcesses = new Map<string, Bun.Subprocess>();

let wireguardPoolEnabled = true;
export function getWireguardPoolEnabled(): boolean {
  return wireguardPoolEnabled;
}
export function setWireguardPoolEnabled(value: boolean): void {
  wireguardPoolEnabled = value;
}

let wireguardImportTail = Promise.resolve();

export async function withWireguardImportLock<T>(task: () => Promise<T>): Promise<T> {
  const previous = wireguardImportTail;
  let release = () => {};
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  wireguardImportTail = previous.then(() => current);
  await previous;
  try {
    return await task();
  } finally {
    release();
  }
}

export function wireguardConfigWithSocks(content: string, port: number): string {
  return content.match(/^\s*\[Socks5\]\s*$/im) ? content : `${content.trimEnd()}\n\n[Socks5]\nBindAddress = 127.0.0.1:${port}\n`;
}

export async function validateWireguardConfig(wireproxyBin: string, configPath: string): Promise<string | null> {
  const configTest = Bun.spawn([wireproxyBin, "-n", "-c", configPath], { stdout: "pipe", stderr: "pipe" });
  const exitCode = await configTest.exited;
  if (exitCode === 0) return null;
  const error = await new Response(configTest.stderr).text();
  return error.trim() || "WireGuard config validation failed.";
}

export function isAllowedWireproxyBin(bin: string): boolean {
  if (bin === "./bin/wireproxy.exe" || bin === "./bin/wireproxy" || bin === "wireproxy") return true;
  if (bin.startsWith("./bin/wireproxy")) return !bin.includes("..") && !bin.includes(";") && !bin.includes("&") && !bin.includes("|");
  return false;
}
