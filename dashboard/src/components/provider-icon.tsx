/**
 * Provider brand icon with a text fallback.
 *
 * Not every provider ships an icon asset, and a missing file must not leave a
 * blank square or retry the same 404 on every mount. The first failure for an
 * icon id is remembered for the session so later mounts render the fallback
 * immediately.
 */

import { memo, useState } from "react";
import { cn } from "../lib/cn";

const failedIcons = new Set<string>();
const iconAssets: Record<string, { file: string; ext: "svg" | "webp" }> = {
  claude: { file: "claude-code", ext: "svg" },
  opencodeft: { file: "opencode", ext: "webp" },
  opencodezen: { file: "opencode", ext: "webp" },
  opencodego: { file: "opencode-go", ext: "webp" },
  "google-antigravity": { file: "antigravity", ext: "svg" },
  antigravity: { file: "antigravity", ext: "svg" },
  blackbox: { file: "blackbox", ext: "svg" },
  blackboxai: { file: "blackbox", ext: "svg" },
  grok: { file: "grok", ext: "svg" },
  "grok-build": { file: "grok-build", ext: "svg" },
  inferhub: { file: "inferhub", ext: "svg" },
  gemini: { file: "gemini", ext: "svg" },
  groq: { file: "groq", ext: "svg" },
  alibaba: { file: "alibaba", ext: "svg" },
  fireworks: { file: "fireworks", ext: "svg" },
  cloudflare: { file: "cloudflare", ext: "svg" },
  exa: { file: "exa", ext: "svg" },
  perplexity: { file: "perplexity", ext: "svg" },
  tokenharbor: { file: "tokenharbor", ext: "svg" },
  aihubmix: { file: "aihubmix", ext: "svg" },
  zai: { file: "zai", ext: "svg" },
  zaicp: { file: "zai-coding-plan", ext: "svg" },
  "kimi-code": { file: "kimi-code", ext: "svg" },
  github: { file: "github-copilot", ext: "svg" },
  xiaomipg: { file: "mimo", ext: "webp" },
  xiaomitp: { file: "mimo", ext: "webp" },
  cb: { file: "codebuddy", ext: "svg" },
  cbcn: { file: "codebuddy", ext: "svg" },
  agentrouter: { file: "agentrouter", ext: "svg" },
  "devin-search": { file: "devin-search", ext: "svg" },
  parallel: { file: "parallel", ext: "svg" },
  gmi: { file: "gmi-cloud", ext: "svg" },
  alibabacp: { file: "alibaba-coding-plan", ext: "svg" },
  hermes: { file: "nous-research", ext: "svg" },
  bai: { file: "bai", ext: "svg" },
  "cline-pass": { file: "cline", ext: "webp" },
};

function assetFor(icon: string): { file: string; ext: "svg" | "webp" } {
  return iconAssets[icon] ?? { file: icon, ext: "webp" };
}

/** Derives the two-letter fallback shown when no icon asset resolves. */
function initialsOf(name: string): string {
  const words = name.trim().split(/[\s-]+/).filter(Boolean);
  if (words.length >= 2) return (words[0]![0]! + words[1]![0]!).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

export const ProviderIcon = memo(function ProviderIcon({
  icon,
  name,
  size = 32,
  className,
}: {
  icon: string;
  name: string;
  size?: number;
  className?: string;
}) {
  const [failed, setFailed] = useState(() => failedIcons.has(icon));

  return (
    <div
      className={cn(
        "flex shrink-0 items-center justify-center overflow-hidden rounded-[var(--radius-md)] bg-[var(--surface-muted)] text-[var(--text-1)] [content-visibility:auto] [contain-intrinsic-size:32px]",
        className
      )}
      role="img"
      aria-label={`${name} provider`}
      style={{ width: size, height: size }}
    >
      {failed ? (
        <span aria-hidden="true" className="text-[11px] font-bold tracking-tight text-[var(--text-secondary)]">{initialsOf(name)}</span>
      ) : (
        <img
          src={`${import.meta.env.BASE_URL}providers/${assetFor(icon).file}.${assetFor(icon).ext}`}
          alt=""
          width={size}
          height={size}
          loading="lazy"
          decoding="async"
          fetchPriority="low"
          className="h-full w-full object-contain p-1"
          onError={() => {
            failedIcons.add(icon);
            setFailed(true);
          }}
        />
      )}
    </div>
  );
});
