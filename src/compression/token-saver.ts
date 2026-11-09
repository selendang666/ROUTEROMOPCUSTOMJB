import type { ContentBlock, NormalizedMessage } from "../proxy/types/content.js";
import type { ProxyRequest } from "../proxy/types/request.js";
import { COMPRESSION_EMERGENCY_MESSAGE_THRESHOLD } from "./ponytail.js";

// ---------------------------------------------------------------------------
// RTK / Token Saver — single application owner, wired once per request.
// Preserves enabled/quality/emergency/recent-turn/tool-result semantics.
// No Headroom import/call/dependency.
// ---------------------------------------------------------------------------

export type TokenSaverQuality = "lite" | "balanced" | "extreme";

export interface TokenSaverConfig {
  readonly enabled: boolean;
  readonly quality: TokenSaverQuality;
  readonly smartTruncate?: boolean;
  readonly emergency?: boolean;
}

const QUALITY_LIMITS: Record<TokenSaverQuality, { readonly maxChars: number; readonly keepLastTurns: number }> = {
  lite: { maxChars: 8_000, keepLastTurns: 3 },
  balanced: { maxChars: 4_000, keepLastTurns: 2 },
  extreme: { maxChars: 2_000, keepLastTurns: 1 },
};

const MIN_COMPRESSIBLE = 500;

const HUNK_RE = /^@@ .+ @@/;

// ---------------------------------------------------------------------------
// RTK helpers — inlined (no Headroom, no external import)
// ---------------------------------------------------------------------------

export type CompressionFilter = "git-diff" | "git-status" | "tree" | "read-numbered" | "grep" | "dedup-log" | "generic";

const DETECT_WINDOW = 8_192;

const RE_GIT_DIFF = /^diff --git |^@@ /m;

const RE_GIT_STATUS = /^On branch |^nothing to commit|^Changes (not |to be )|^Untracked files:/m;

const RE_PORCELAIN = /^[ MADRCU?!][ MADRCU?!] \S/m;

const RE_TREE = /[├└]──|│  /;

const RE_LS = /^[-dlbcps][rwx-]{9}/m;

const RE_GREP = /^[^\s:]+:\d+:/;

const RE_NUMBERED = /^\s*\d+[→|\t]\s/;

export function autoDetectFilter(text: string): CompressionFilter | null {
  const head = text.length > DETECT_WINDOW ? text.slice(0, DETECT_WINDOW) : text;
  if (RE_GIT_DIFF.test(head)) return "git-diff";
  if (RE_GIT_STATUS.test(head) || isMostlyPorcelain(head)) return "git-status";
  const lines = head.split("\n");
  const nonEmpty = lines.filter((line) => line.trim().length > 0);
  if (nonEmpty.slice(0, 5).some((line) => RE_GREP.test(line))) return "grep";
  if (nonEmpty.length >= 3 && nonEmpty.every((line) => isPathLike(line))) return "tree";
  if (RE_TREE.test(head) || RE_LS.test(head)) return "tree";
  if (lines.length >= 5 && lines.filter((line) => line.length > 0 && RE_NUMBERED.test(line)).length / Math.max(1, nonEmpty.length) >= 0.6) return "read-numbered";
  if (hasAdjacentDuplicates(nonEmpty)) return "dedup-log";
  return null;
}

function isMostlyPorcelain(text: string): boolean {
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length < 3) return false;
  return lines.filter((line) => RE_PORCELAIN.test(line)).length / lines.length >= 0.6;
}

function isPathLike(line: string): boolean {
  const value = line.trim();
  if (value.length === 0) return false;
  if (/^[A-Za-z]:[\\/]/.test(value)) return true;
  if (value.includes(":")) return false;
  return value.startsWith(".") || value.startsWith("/") || value.includes("/");
}

function hasAdjacentDuplicates(lines: readonly string[]): boolean {
  let duplicates = 0;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index] === lines[index - 1]) duplicates += 1;
  }
  return duplicates >= 3;
}

function generic(text: string, maxChars: number): string {
  const headSize = Math.floor(maxChars * 0.7);
  const tailSize = Math.max(0, maxChars - headSize - 80);
  const tail = tailSize > 0 ? text.slice(-tailSize) : "";
  const dropped = text.length - headSize - tail.length;
  const lines = (text.slice(headSize, text.length - tail.length).match(/\n/g) ?? []).length;
  return `${text.slice(0, headSize)}\n\n…[truncated ${dropped} chars / ~${lines} lines]…\n\n${tail}`;
}

function gitDiff(text: string, maxChars: number): string {
  const lines = text.split("\n");
  const output: string[] = [];
  for (let index = 0; index < lines.length; ) {
    if (!HUNK_RE.test(lines[index] ?? "")) {
      output.push(lines[index] ?? "");
      index += 1;
      continue;
    }
    const start = index;
    index += 1;
    while (index < lines.length && !HUNK_RE.test(lines[index] ?? "") && !lines[index]?.startsWith("diff --git ")) index += 1;
    const hunk = lines.slice(start, index);
    output.push(...(hunk.length <= 11 ? hunk : [hunk[0] ?? "", ...hunk.slice(1, 6), `…[${hunk.length - 11} hunk lines elided]…`, ...hunk.slice(-5)]));
  }
  const result = output.join("\n");
  return result.length > maxChars ? generic(result, maxChars) : result;
}

function gitStatus(text: string): string {
  const staged: string[] = [];
  const modified: string[] = [];
  const untracked: string[] = [];
  let branch = "";
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    if (line.startsWith("On branch ")) branch = line.slice(10);
    if (line.startsWith("## ")) branch = line.slice(3);
    if (/^[ MADRCU?!][ MADRCU?!] /.test(raw)) {
      const path = raw.slice(3);
      if (raw.startsWith("?? ")) untracked.push(path);
      else {
        if ("MADRC".includes(raw[0] ?? "")) staged.push(path);
        if ((raw[1] ?? "") === "M") modified.push(path);
      }
    }
  }
  if (staged.length + modified.length + untracked.length === 0) return text;
  const section = (label: string, entries: string[]) =>
    entries.length === 0 ? [] : [`${label}: ${entries.length}`, ...entries.slice(0, 10).map((entry) => `  ${entry}`), ...(entries.length > 10 ? [`  … +${entries.length - 10} more`] : [])];
  return [branch ? `* ${branch}` : "", ...section("Staged", staged), ...section("Modified", modified), ...section("Untracked", untracked)].filter(Boolean).join("\n");
}

function tree(text: string, maxChars: number): string {
  const kept: string[] = [];
  let dropped = 0;
  let keptChars = 0;
  for (const line of text.split("\n")) {
    const indent = (line.match(/^[│ ]*/) ?? [""])[0].length / 2;
    if (indent <= 1) {
      kept.push(line);
      keptChars += line.length + (kept.length > 1 ? 1 : 0);
    } else dropped += 1;
    if (keptChars > maxChars - 100) break;
  }
  return `${kept.join("\n")}\n…[${dropped} deeper entries collapsed]…`;
}

function readNumbered(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const lines = text.split("\n");
  const head: string[] = [];
  const tail: string[] = [];
  let headSize = 0;
  let tailSize = 0;
  for (const line of lines) {
    if (headSize + line.length > maxChars * 0.6) break;
    head.push(line);
    headSize += line.length + 1;
  }
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? "";
    if (tailSize + line.length > maxChars * 0.3) break;
    tail.unshift(line);
    tailSize += line.length + 1;
  }
  return [...head, `…[${Math.max(0, lines.length - head.length - tail.length)} numbered lines elided]…`, ...tail].join("\n");
}

function grep(text: string, maxChars: number): string {
  const lines = text.split("\n");
  const groups = new Map<string, string[]>();
  for (const line of lines) {
    const match = line.match(/^([^\s:]+):(\d+):(.*)$/);
    if (!match) continue;
    const path = match[1] ?? "unknown";
    const current = groups.get(path) ?? [];
    current.push(`${match[2]}: ${(match[3] ?? "").trim()}`);
    groups.set(path, current);
  }
  if (groups.size === 0) return text;
  const output: string[] = ["Compression grep summary:"];
  for (const [path, matches] of groups) {
    output.push(`[${path}] (${matches.length})`, ...matches.slice(0, 5).map((match) => `  ${match}`));
    if (matches.length > 5) output.push(`  … +${matches.length - 5} more`);
    if (output.join("\n").length > maxChars) break;
  }
  return output.join("\n");
}

function dedupLog(text: string): string {
  const output: string[] = [];
  let previous: string | undefined;
  let duplicates = 0;
  const flush = () => {
    if (duplicates > 0) output.push(`  … (${duplicates} duplicate ${duplicates === 1 ? "line" : "lines"})`);
  };
  for (const line of text.split("\n")) {
    if (line === previous) {
      duplicates += 1;
      continue;
    }
    flush();
    output.push(line);
    previous = line;
    duplicates = 0;
  }
  flush();
  return output.join("\n");
}

function smartTruncate(text: string, maxChars: number, smart: boolean): { text: string; filter: CompressionFilter | null } {
  if (text.length < MIN_COMPRESSIBLE) return { text, filter: null };
  const fits = text.length <= maxChars;
  const probe = text.slice(0, 1_024);
  const candidates: Array<{ filter: CompressionFilter; detect: boolean; apply: () => string; lossless?: boolean }> = [
    { filter: "git-diff", detect: RE_GIT_DIFF.test(probe), apply: () => gitDiff(text, maxChars) },
    { filter: "git-status", detect: RE_GIT_STATUS.test(probe) || isMostlyPorcelain(probe), apply: () => gitStatus(text) },
    { filter: "grep", detect: probe.split("\n").slice(0, 5).some((l) => RE_GREP.test(l)), apply: () => grep(text, maxChars) },
    { filter: "tree", detect: RE_TREE.test(probe), apply: () => tree(text, maxChars) },
    { filter: "read-numbered", detect: RE_NUMBERED.test(probe), apply: () => readNumbered(text, maxChars) },
    { filter: "dedup-log", detect: hasAdjacentDuplicates(probe.split("\n")), apply: () => dedupLog(text), lossless: true },
  ];
  for (const c of candidates) {
    if (!c.detect) continue;
    const truncated = c.apply();
    if (c.lossless) {
      if (truncated.length < text.length) return { text: truncated, filter: c.filter };
      continue;
    }
    return { text: truncated, filter: c.filter };
  }
  const auto = smart ? autoDetectFilter(text) : null;
  if (auto !== null) {
    const map: Record<string, () => string> = {
      "git-diff": () => gitDiff(text, maxChars),
      "git-status": () => gitStatus(text),
      tree: () => tree(text, maxChars),
      "read-numbered": () => readNumbered(text, maxChars),
      grep: () => grep(text, maxChars),
      "dedup-log": () => dedupLog(text),
    };
    const fn = map[auto];
    if (fn !== undefined) {
      const truncated = fn();
      if (truncated !== text) return { text: truncated, filter: auto };
    }
  }
  return fits ? { text, filter: null } : { text: generic(text, maxChars), filter: "generic" };
}

/** Applies the smart-filter pipeline to older tool results. Preserves recent turns. */
export function applyTokenSaver(request: ProxyRequest, config: TokenSaverConfig): ProxyRequest {
  const emergency = config.emergency === true || request.messages.length > COMPRESSION_EMERGENCY_MESSAGE_THRESHOLD;
  if (!config.enabled && !emergency) return request;
  if (request.messages.length === 0) return request;
  const limits = QUALITY_LIMITS[config.quality] ?? QUALITY_LIMITS.balanced;
  const cutoff = Math.max(0, request.messages.length - limits.keepLastTurns * 2);
  let messages: NormalizedMessage[] | null = null;
  for (let index = 0; index < cutoff; index += 1) {
    const message = request.messages[index];
    if (message === undefined) continue;
    let content: ContentBlock[] | null = null;
    for (let blockIndex = 0; blockIndex < message.content.length; blockIndex += 1) {
      const block = message.content[blockIndex];
      if (block === undefined) continue;
      if (block.type !== "tool_result" || typeof block.text !== "string") continue;
      const result = smartTruncate(block.text, limits.maxChars, config.smartTruncate !== false);
      if (result.text === block.text) continue;
      content ??= [...message.content];
      content[blockIndex] = { ...block, text: result.text };
    }
    if (content === null) continue;
    messages ??= [...request.messages];
    messages[index] = { ...message, content };
  }
  return messages === null ? request : { ...request, messages };
}

/** Simple head+tail truncation with truncation notice. */
export function genericTruncate(text: string, maxChars: number): string {
  const headSize = Math.floor(maxChars * 0.7);
  const tailSize = Math.max(0, maxChars - headSize - 80);
  const tail = tailSize > 0 ? text.slice(-tailSize) : "";
  const dropped = text.length - headSize - tail.length;
  const lines = (text.slice(headSize, text.length - tail.length).match(/\n/g) ?? []).length;
  return `${text.slice(0, headSize)}\n\n…[truncated ${dropped} chars / ~${lines} lines]…\n\n${tail}`;
}
