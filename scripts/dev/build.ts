#!/usr/bin/env bun
/**
 * bun:build — auto-detect OS + build dashboard + binary (single command)
 *
 * Usage:
 *   bun run bun:build              # auto OS (win→.exe, linux→elf, mac→macho) + dashboard
 *   bun run bun:build -- --no-dashboard  # cuma binary
 *   bun run bun:build -- --target=bun-linux-x64  # cross-compile
 *   OHMYOMOP_ROUTER_PROVIDER_PROFILE=optional bun run bun:build
 *
 * Output:
 *   bin/ohmyomop-router[.exe]   (atau bin/ohmyomop-router-<target> kalau cross)
 *   dashboard/dist/
 */
import { $ } from "bun";
import { existsSync, mkdirSync } from "node:fs";

const args = process.argv.slice(2);
const noDashboard = args.includes("--no-dashboard");
const targetArg = args.find((a) => a.startsWith("--target="));
const explicitTarget = targetArg ? targetArg.split("=")[1] : null;

async function main() {
  const platform = process.platform; // win32, linux, darwin
  const arch = process.arch; // x64, arm64

  // Auto outfile — .exe di Windows, tanpa ext di Unix
  function outfileFor(target: string | null): string {
    const base = "bin/ohmyomop-router";
    if (target) {
      // cross-compile: bin/ohmyomop-router-bun-linux-x64[.exe]
      const safe = target.replace(/[^a-z0-9-]/gi, "-");
      return `${base}-${safe}${platform === "win32" ? ".exe" : ""}`;
    }
    return `${base}${platform === "win32" ? ".exe" : ""}`;
  }

  const target = explicitTarget ?? "bun"; // "bun" = auto current OS
  const outfile = outfileFor(explicitTarget);

  if (!existsSync("bin")) mkdirSync("bin", { recursive: true });

  console.log(`\n▶ bun:build — ${platform}/${arch} → ${outfile} (target=${target})${noDashboard ? " (no dashboard)" : ""}\n`);

  if (!noDashboard) {
    console.log("▶ building dashboard (vite)...");
    await $`bun run --cwd dashboard build`.quiet(false);
    console.log("  ✓ dashboard/dist");
  }

  console.log(`▶ building binary --compile --minify --bytecode --target ${target} ...`);
  const env = { ...process.env };
  // Keep OHMYOMOP_ROUTER_PROVIDER_PROFILE if set (optional heavy providers)
  await $`bun build --compile --minify --bytecode --target ${target} --outfile ${outfile} src/main.ts`.env(env).quiet(false);

  console.log(`\n  ✓ ${outfile} (${platform}/${arch})`);
  if (platform === "linux") console.log(`    AppImage: wrap dengan appimagetool → ${outfile}.AppImage`);
  console.log("");
}

await main();
