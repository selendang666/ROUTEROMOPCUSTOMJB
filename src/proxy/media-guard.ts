import type { ProtocolError } from "./errors.js";
import { isProtocolError, protocolError } from "./errors.js";
import type { ImageReference } from "./types/content.js";
import { MAX_DATA_URL_LENGTH, MAX_IMAGE_COUNT, MAX_IMAGE_URL_LENGTH, MAX_MEDIA_TYPE_LENGTH } from "./validation.js";

/**
 * SSRF-safe image reference classification.
 *
 * Normalization never fetches image payloads; it only classifies the
 * reference syntactically so a later image transformation can run
 * without ever touching private, loopback, or reserved targets:
 *
 * - `data:` URLs are bounded inline payloads and always safe.
 * - `http(s)` URLs must be absolute, credential-free, and resolve to a
 *   public address: no IP literals in private/loopback/link-local/reserved
 *   ranges (IPv4 and IPv6, including IPv4-mapped/NAT64/4-in-6 encodings),
 *   no localhost/private-use names, no ambiguous single-label hosts.
 * - Anything else is rejected with a typed ProtocolError.
 */
export type ImageClassification =
  | { readonly ok: true; readonly reference: ImageReference }
  | { readonly ok: false; readonly error: ProtocolError };

export function classifyImageReference(value: unknown, field: string): ImageClassification {
  if (typeof value !== "string") return fail(field, `${field}: expected a string reference`);
  const trimmed = value.trim();
  if (trimmed === "") return fail(field, `${field}: image reference must not be empty`);
  if (/^data:/i.test(trimmed)) return classifyDataUrl(trimmed, field);
  return classifyHttpUrl(trimmed, field);
}

/** Appends a classified reference, enforcing the global image-count bound. */
export function pushImageReference(target: ImageReference[], reference: ImageReference, field: string): ProtocolError | null {
  if (target.length >= MAX_IMAGE_COUNT) return protocolError(field, `${field}: exceeds maximum of ${MAX_IMAGE_COUNT} images`);
  target.push(reference);
  return null;
}

function fail(field: string, message: string): ImageClassification {
  return { ok: false, error: protocolError(field, message) };
}

function classifyDataUrl(value: string, field: string): ImageClassification {
  if (value.length > MAX_DATA_URL_LENGTH) return fail(field, `${field}: inline image exceeds ${MAX_DATA_URL_LENGTH} characters`);
  const comma = value.indexOf(",");
  if (comma < 0) return fail(field, `${field}: malformed data URL (missing ",")`);
  const meta = value.slice("data:".length, comma);
  const mediaType = parseMediaType(meta, field);
  if (isProtocolError(mediaType)) return { ok: false, error: mediaType };
  return { ok: true, reference: { kind: "data", value, mediaType } };
}

function parseMediaType(meta: string, field: string): string | null | ProtocolError {
  const first = meta.split(";")[0];
  if (first === undefined || first === "") return null;
  const mediaType = first.toLowerCase();
  if (mediaType.length > MAX_MEDIA_TYPE_LENGTH) return protocolError(field, `${field}: media type exceeds ${MAX_MEDIA_TYPE_LENGTH} characters`);
  return mediaType;
}

function classifyHttpUrl(value: string, field: string): ImageClassification {
  if (value.length > MAX_IMAGE_URL_LENGTH) return fail(field, `${field}: URL exceeds ${MAX_IMAGE_URL_LENGTH} characters`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fail(field, `${field}: malformed URL`);
  }
  const scheme = url.protocol;
  if (scheme !== "http:" && scheme !== "https:") return fail(field, `${field}: unsupported URL scheme "${scheme.slice(0, -1) || "?"}"`);
  if (url.username !== "" || url.password !== "") return fail(field, `${field}: URLs with embedded credentials are not allowed`);
  const hostname = normalizeHostname(url.hostname);
  if (hostname === null) return fail(field, `${field}: URL has no usable host`);
  if (isPrivateUseName(hostname)) return fail(field, `${field}: URL host is a loopback or private-use name`);
  if (isIpLiteral(hostname)) {
    if (isUnsafeIp(hostname)) return fail(field, `${field}: URL host is a private, loopback, or reserved address`);
  } else if (!hostname.includes(".")) {
    return fail(field, `${field}: URL host must be a fully qualified domain name`);
  }
  return { ok: true, reference: { kind: "url", value, mediaType: null } };
}

export function normalizeHostname(host: string): string | null {
  let value = host.toLowerCase();
  if (value.startsWith("[") && value.endsWith("]")) value = value.slice(1, -1);
  const zone = value.indexOf("%");
  if (zone >= 0) value = value.slice(0, zone);
  value = value.replace(/\.$/, "");
  return value === "" ? null : value;
}

export function isPrivateUseName(host: string): boolean {
  if (host === "localhost") return true;
  for (const suffix of [".localhost", ".local", ".internal", ".localdomain", ".home.arpa", ".lan"]) {
    if (host.endsWith(suffix)) return true;
  }
  return false;
}

export function isIpLiteral(host: string): boolean {
  return isIpv4Literal(host) || (host.includes(":") && ipv6ToBigInt(host) !== null);
}

function isIpv4Literal(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return false;
    if (Number(part) > 255) return false;
  }
  return true;
}

export function isUnsafeIp(host: string): boolean {
  if (isIpv4Literal(host)) return isUnsafeIpv4(ipv4ToUint32(host));
  const value = ipv6ToBigInt(host);
  if (value === null) return true;
  return isUnsafeIpv6(value);
}

function ipv4ToUint32(host: string): number {
  const parts = host.split(".");
  return ((Number(parts[0]) * 256 + Number(parts[1])) * 256 + Number(parts[2])) * 256 + Number(parts[3]);
}

function isUnsafeIpv4(value: number): boolean {
  return (
    value < 0x01000000 || // 0.0.0.0/8
    (value >= 0x0a000000 && value < 0x0b000000) || // 10.0.0.0/8
    (value >= 0x64400000 && value < 0x64800000) || // 100.64.0.0/10 (CGNAT)
    (value >= 0x7f000000 && value < 0x80000000) || // 127.0.0.0/8 (loopback)
    (value >= 0xa9fe0000 && value < 0xa9ff0000) || // 169.254.0.0/16 (link-local)
    (value >= 0xac100000 && value < 0xac200000) || // 172.16.0.0/12
    (value >= 0xc0000000 && value < 0xc0000100) || // 192.0.0.0/24
    (value >= 0xc0000200 && value < 0xc0000300) || // 192.0.2.0/24 (TEST-NET-1)
    (value >= 0xc0a80000 && value < 0xc0a90000) || // 192.168.0.0/16
    (value >= 0xc6120000 && value < 0xc6140000) || // 198.18.0.0/15 (benchmarking)
    (value >= 0xc6336400 && value < 0xc6336500) || // 198.51.100.0/24 (TEST-NET-2)
    (value >= 0xcb007100 && value < 0xcb007200) || // 203.0.113.0/24 (TEST-NET-3)
    value >= 0xe0000000 // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved
  );
}

interface BigIntRange {
  readonly lo: bigint;
  readonly hi: bigint;
}

function ipv6Range(prefixHex: string, prefixBits: number): BigIntRange {
  const prefix = BigInt(`0x${prefixHex}`);
  const freeBits = 128n - BigInt(prefixBits);
  const mask = (1n << 128n) - (1n << freeBits);
  const lo = prefix & mask;
  return { lo, hi: lo | ((1n << freeBits) - 1n) };
}

const UNSAFE_IPV6_RANGES: readonly BigIntRange[] = [
  ipv6Range("00000000000000000000000000000000", 128), // ::
  ipv6Range("00000000000000000000000000000001", 128), // ::1
  ipv6Range("00000000000000000000000000000000", 96), // ::/96 (IPv4-compatible)
  ipv6Range("00000000000000000000ffff00000000", 96), // ::ffff:0:0/96 (IPv4-mapped)
  ipv6Range("0064ff9b000000000000000000000000", 96), // 64:ff9b::/96 (NAT64)
  ipv6Range("0064ff9b000100000000000000000000", 48), // 64:ff9b:1::/48 (NAT64 local-use)
  ipv6Range("fc000000000000000000000000000000", 7), // fc00::/7 (unique-local)
  ipv6Range("fe800000000000000000000000000000", 10), // fe80::/10 (link-local)
  ipv6Range("ff000000000000000000000000000000", 8), // ff00::/8 (multicast)
  ipv6Range("20010db8000000000000000000000000", 32), // 2001:db8::/32 (documentation)
  ipv6Range("20010010000000000000000000000000", 28), // 2001:10::/28 (ORCHID)
  ipv6Range("20010002000000000000000000000000", 48), // 2001:2::/48 (benchmarking)
  ipv6Range("01000000000000000000000000000000", 64), // 100::/64 (discard-only)
];

function isUnsafeIpv6(value: bigint): boolean {
  for (const range of UNSAFE_IPV6_RANGES) {
    if (value >= range.lo && value <= range.hi) return true;
  }
  const embedded = embeddedIpv4(value);
  if (embedded !== null && isUnsafeIpv4(embedded)) return true;
  return false;
}

function embeddedIpv4(value: bigint): number | null {
  if (value < 0x100000000n) return Number(value); // ::/96
  const upper = value >> 32n;
  if (upper === 0xffffn) return Number(value & 0xffffffffn); // ::ffff:0:0/96
  if (upper === 0x64ff9bn) return Number(value & 0xffffffffn); // 64:ff9b::/96
  return null;
}

function parseHextet(part: string): number | null {
  if (!/^[0-9a-f]{1,4}$/i.test(part)) return null;
  return Number.parseInt(part, 16);
}

function ipv4ToHextets(part: string): readonly [number, number] | null {
  const octets = part.split(".");
  if (octets.length !== 4) return null;
  const nums: number[] = [];
  for (const octet of octets) {
    if (!/^\d{1,3}$/.test(octet)) return null;
    const value = Number(octet);
    if (value > 255) return null;
    nums.push(value);
  }
  return [(nums[0] ?? 0) * 256 + (nums[1] ?? 0), (nums[2] ?? 0) * 256 + (nums[3] ?? 0)];
}

export function ipv6ToBigInt(host: string): bigint | null {
  if (!host.includes(":")) return null;
  const compressed = host.split("::");
  if (compressed.length > 2) return null;
  let left: string[] = compressed[0] === "" ? [] : (compressed[0] ?? "").split(":");
  let right: string[] = compressed.length === 2 ? (compressed[1] === "" ? [] : (compressed[1] ?? "").split(":")) : [];
  let v4: readonly [number, number] | null = null;
  const lastLeft = left[left.length - 1];
  if (lastLeft !== undefined && lastLeft.includes(".")) {
    v4 = ipv4ToHextets(lastLeft);
    if (v4 === null) return null;
    left = left.slice(0, -1);
  } else {
    const lastRight = right[right.length - 1];
    if (lastRight !== undefined && lastRight.includes(".")) {
      v4 = ipv4ToHextets(lastRight);
      if (v4 === null) return null;
      right = right.slice(0, -1);
    }
  }
  const groups: number[] = [];
  for (const part of left) {
    const hextet = parseHextet(part);
    if (hextet === null) return null;
    groups.push(hextet);
  }
  if (compressed.length === 2) {
    const missing = 8 - groups.length - right.length - (v4 === null ? 0 : 2);
    if (missing < 0) return null;
    for (let i = 0; i < missing; i++) groups.push(0);
  }
  for (const part of right) {
    const hextet = parseHextet(part);
    if (hextet === null) return null;
    groups.push(hextet);
  }
  if (v4 !== null) groups.push(v4[0], v4[1]);
  if (groups.length !== 8) return null;
  let value = 0n;
  for (const group of groups) {
    value = (value << 16n) | BigInt(group);
  }
  return value;
}
