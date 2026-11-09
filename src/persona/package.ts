/**
 * Persona pack parser — one zip in, one validated persona out.
 *
 * Pack convention (agreed):
 *   persona.yaml   flat `key: value` manifest: name, version
 *   SOUL.md        main persona / soul document
 *   files/*.md     optional extra documents, appended in sorted order
 *
 * Only `.md`, `.yaml`, `.yml`, `.txt` entries are accepted. Everything is
 * validated before anything is stored: size caps, entry count caps, no
 * absolute paths, no `..` traversal, no duplicate names.
 */
import { strFromU8, unzipSync, zipSync } from "fflate";
import { TextDecoder } from "node:util";

/** Manifest parsed from `persona.yaml` (flat `key: value` subset only). */
export interface PersonaManifest {
  readonly name: string;
  readonly version: string;
}

/** Validated persona pack ready to store. */
export interface PersonaPack {
  readonly manifest: PersonaManifest;
  readonly soul: string;
  readonly extras: ReadonlyArray<{ readonly path: string; readonly text: string }>;
  /** Assembled system-prompt text: SOUL.md followed by extras. */
  readonly content: string;
}

/** Thrown for any malformed or unsafe pack; message is console-safe. */
export class PersonaPackError extends Error {
  /** Machine-readable reason: `too_large` | `too_many_files` | `unsafe_path` | `bad_type` | `missing_file` | `bad_manifest` | `empty` | `bad_zip`. */
  readonly reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.name = "PersonaPackError";
    this.reason = reason;
  }
}

/** Max accepted zip bytes (100 MB). */
export const MAX_PACK_BYTES = 100 * 1000 * 1000;
/** Max accepted entries per zip. */
export const MAX_PACK_FILES = 100;
/** Max accepted decoded text per entry (512 KiB). */
export const MAX_ENTRY_CHARS = 512 * 1024;
export const MAX_ENTRY_BYTES = 32 * 1024 * 1024;
export const MAX_PACK_UNCOMPRESSED_BYTES = 256 * 1000 * 1000;

const ALLOWED_EXT = new Set([".md", ".yaml", ".yml", ".txt"]);
const utf8 = new TextDecoder("utf-8", { fatal: false });

function extOf(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot < 0 ? "" : path.slice(dot).toLowerCase();
}

/**
 * Parses the flat `key: value` subset of YAML used by `persona.yaml`.
 * Ignores blank lines and `#` comments; strips single/double quotes.
 */
function parseFlatYaml(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const colon = trimmed.indexOf(":");
    if (colon < 0) continue;
    const key = trimmed.slice(0, colon).trim();
    let value = trimmed.slice(colon + 1).trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    if (key.length > 0 && out[key] === undefined) out[key] = value;
  }
  return out;
}

/**
 * Validates a raw zip entry name against traversal and type rules.
 * @param raw Raw entry name from the archive.
 * @returns Normalized `a/b/c` path.
 * @throws PersonaPackError on unsafe or disallowed names.
 */
export function sanitizeEntryPath(raw: string): string {
  const normalized = raw.replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    /(^|\/)\.\.(\/|$)/.test(normalized) ||
    normalized.endsWith("/")
  ) {
    throw new PersonaPackError("unsafe_path", `Unsafe zip entry: ${raw.slice(0, 80)}`);
  }
  if (!ALLOWED_EXT.has(extOf(normalized))) {
    throw new PersonaPackError("bad_type", `Disallowed file type (only .md/.yaml/.yml/.txt): ${normalized.slice(0, 80)}`);
  }
  return normalized;
}

/**
 * Assembles the injectable system-prompt text from soul + extras.
 * @param soul Main SOUL.md text.
 * @param extras Extra documents in pack order.
 */
export function buildPersonaContent(soul: string, extras: ReadonlyArray<{ path: string; text: string }>): string {
  const parts = [soul.trim()];
  for (const extra of extras) {
    parts.push(`## ${extra.path}\n\n${extra.text.trim()}`);
  }
  return parts.filter((part) => part.length > 0).join("\n\n---\n\n");
}

/**
 * Parses and validates a persona pack zip.
 * @param bytes Raw zip bytes.
 * @returns Validated pack with assembled content.
 * @throws PersonaPackError on any violation.
 */
export function parsePersonaZip(bytes: Uint8Array): PersonaPack {
  if (bytes.length === 0) throw new PersonaPackError("empty", "Empty zip upload");
  if (bytes.length > MAX_PACK_BYTES) throw new PersonaPackError("too_large", `Zip exceeds ${MAX_PACK_BYTES} bytes`);
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch {
    throw new PersonaPackError("bad_zip", "File is not a valid zip archive");
  }
  const names = Object.keys(entries);
  if (names.length === 0) throw new PersonaPackError("empty", "Zip contains no files");
  if (names.length > MAX_PACK_FILES) throw new PersonaPackError("too_many_files", `Zip exceeds ${MAX_PACK_FILES} files`);
  const uncompressedBytes = names.reduce((total, name) => total + (entries[name]?.byteLength ?? 0), 0);
  if (uncompressedBytes > MAX_PACK_UNCOMPRESSED_BYTES) {
    throw new PersonaPackError("too_large", `Zip expands beyond ${MAX_PACK_UNCOMPRESSED_BYTES} bytes`);
  }

  const seen = new Set<string>();
  const decoded = new Map<string, string>();
  for (const raw of names) {
    const path = sanitizeEntryPath(raw);
    if (seen.has(path)) throw new PersonaPackError("unsafe_path", `Duplicate zip entry: ${path}`);
    seen.add(path);
    const bytes = entries[raw]!;
    if (bytes.byteLength > MAX_ENTRY_BYTES) {
      throw new PersonaPackError("too_large", `Entry exceeds ${MAX_ENTRY_BYTES} bytes: ${path.slice(0, 80)}`);
    }
    const text = utf8.decode(bytes).slice(0, MAX_ENTRY_CHARS);
    if (text.trim().length === 0) continue;
    decoded.set(path, text);
  }

  const manifestText = decoded.get("persona.yaml");
  if (manifestText === undefined) throw new PersonaPackError("missing_file", "Pack must contain persona.yaml");
  const manifestRaw = parseFlatYaml(manifestText);
  const name = (manifestRaw.name ?? "").trim();
  const version = (manifestRaw.version ?? "").trim();
  if (name.length === 0) throw new PersonaPackError("bad_manifest", "persona.yaml must define a non-empty name");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
    throw new PersonaPackError("bad_manifest", "persona.yaml name must be alphanumeric with .-_ (max 64 chars)");
  }
  const soul = decoded.get("SOUL.md");
  if (soul === undefined || soul.trim().length === 0) {
    throw new PersonaPackError("missing_file", "Pack must contain a non-empty SOUL.md");
  }
  const extras = [...decoded.entries()]
    .filter(([path]) => path.startsWith("files/") && path !== "files/")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, text]) => ({ path, text }));
  return {
    manifest: { name, version: version.length > 0 ? version : "1" },
    soul,
    extras,
    content: buildPersonaContent(soul, extras),
  };
}

/**
 * Builds a persona pack zip (used by tests and export tooling).
 * @param files Map of archive path to text content.
 */
export function buildPersonaZip(files: Record<string, string>): Uint8Array {
  const input: Record<string, Uint8Array> = {};
  const encoder = new TextEncoder();
  for (const [path, text] of Object.entries(files)) input[path] = encoder.encode(text);
  return zipSync(input);
}

/** Decodes zip entry bytes to text (fflate helper re-export for tests). */
export function zipText(bytes: Uint8Array): string {
  return strFromU8(bytes);
}
