export function verifyTrustedPeerIdentity(
  headers: Headers,
  configuredToken: string | undefined,
): { trusted: boolean; clientIp: string | null } {
  if (!configuredToken || configuredToken.length < 32) return { trusted: false, clientIp: null };
  const token = headers.get("x-ohmyomop-router-peer-token") ?? "";
  // constant time compare
  if (token.length !== configuredToken.length) return { trusted: false, clientIp: null };
  let diff = 0;
  for (let i = 0; i < token.length; i++) diff |= token.charCodeAt(i) ^ configuredToken.charCodeAt(i);
  if (diff !== 0) return { trusted: false, clientIp: null };
  const realIp = headers.get("x-ohmyomop-router-real-ip");
  if (realIp && /^(\d{1,3}\.){3}\d{1,3}$|^([a-fA-F0-9:]+)$/.test(realIp)) {
    return { trusted: true, clientIp: realIp };
  }
  return { trusted: true, clientIp: null };
}
