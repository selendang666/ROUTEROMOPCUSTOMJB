import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");
const PACKAGE_PATHS = [
  resolve(ROOT, "package.json"),
  resolve(ROOT, "dashboard", "package.json"),
] as const;
const RUNTIME_VERSION_PATH = resolve(ROOT, "src", "runtime", "runtime.ts");

interface PackageManifest {
  readonly version?: unknown;
}

function usage(): never {
  console.error("Usage: bun run scripts/sync-versions.ts [--check | --write]");
  process.exit(2);
}

async function readManifest(path: string): Promise<{ readonly path: string; readonly raw: string; readonly version: string }> {
  const raw = await readFile(path, "utf8");
  const manifest = JSON.parse(raw) as PackageManifest;
  if (typeof manifest.version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version)) {
    throw new Error(`${path} must contain a valid semantic version.`);
  }
  return { path, raw, version: manifest.version };
}

const mode = process.argv[2] ?? "--check";
if (mode !== "--check" && mode !== "--write") usage();

const manifests = await Promise.all(PACKAGE_PATHS.map(readManifest));
const root = manifests[0];
if (root === undefined) throw new Error("Root package manifest is missing.");
const mismatches = manifests.filter((manifest) => manifest.version !== root.version);
const runtime = await readFile(RUNTIME_VERSION_PATH, "utf8");
const runtimePattern = /export const OHMYOMOP_ROUTER_VERSION = "[^"]+";/;
const expectedRuntimeLine = `export const OHMYOMOP_ROUTER_VERSION = "${root.version}";`;
const runtimeMatches = runtime.includes(expectedRuntimeLine);

if (mode === "--check") {
  if (mismatches.length === 0 && runtimeMatches) {
    console.log(`Version lockstep verified: ${root.version}`);
    process.exit(0);
  }
  console.error(`Version lockstep failed; expected ${root.version}.`);
  for (const mismatch of mismatches) console.error(`- ${mismatch.path}: ${mismatch.version}`);
  if (!runtimeMatches) console.error(`- ${RUNTIME_VERSION_PATH}: runtime version does not match`);
  process.exit(1);
}

for (const manifest of manifests.slice(1)) {
  if (manifest.version === root.version) continue;
  const next = manifest.raw.replace(/"version"\s*:\s*"[^"]+"/, `"version": "${root.version}"`);
  await writeFile(manifest.path, next, "utf8");
}
if (!runtimePattern.test(runtime)) throw new Error("Runtime version declaration is missing.");
await writeFile(RUNTIME_VERSION_PATH, runtime.replace(runtimePattern, expectedRuntimeLine), "utf8");
console.log(`Version lockstep synchronized: ${root.version}`);
