/**
 * Hermes sync — mirrors the active router persona into the Hermes agent home
 * so gateway traffic AND local Hermes sessions share one locked persona.
 *
 * Layout (matches the existing Hermes convention on this host):
 *   $HERMES_HOME/SOUL.md                 canonical soul, auto-loaded per session
 *   $HERMES_HOME/SOUL.md.bak.<stamp>     timestamped backup of the previous soul
 *   $HERMES_HOME/persona/<name>/SOUL.md  per-profile copy
 *   $HERMES_HOME/persona/<name>/persona.yaml  provenance manifest
 *
 * Home resolution: `OHMYOMOP_ROUTER_HERMES_HOME` > `HERMES_HOME` > `~/.hermes`.
 * Never touches `config.yaml` or `.env` — soul markdown only.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { ensureDir, readTextFile, writeTextFile } from "../console/cli-tools/fs-ops.js";

/** Result of a Hermes persona sync. */
export interface HermesSyncResult {
  readonly home: string;
  readonly soulPath: string;
  readonly profilePath: string;
  readonly backedUp: string | null;
  readonly at: string;
}

/**
 * Resolves the Hermes home directory from env, defaulting to `~/.hermes`.
 * @returns Absolute home path.
 */
export function hermesHome(): string {
  const override = (process.env.OHMYOMOP_ROUTER_HERMES_HOME ?? process.env.HERMES_HOME ?? "").trim();
  if (override.length > 0) return override;
  return join(homedir(), ".hermes");
}

function stamp(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/**
 * Writes a persona pack into the Hermes home, backing up the previous soul.
 * Creates missing directories; keeps at most 5 soul backups.
 * @param input Persona name, version and soul text.
 * @returns Sync result with written paths.
 */
export async function syncPersonaToHermes(input: { name: string; version: string; soul: string }): Promise<HermesSyncResult> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(input.name)) {
    throw new Error("Invalid persona name");
  }
  const home = hermesHome();
  const profileDir = join(home, "persona", input.name);
  await ensureDir(home);
  await ensureDir(profileDir);

  const soulPath = join(home, "SOUL.md");
  const previous = await readTextFile(soulPath);
  let backedUp: string | null = null;
  if (previous !== null) {
    const backupPath = `${soulPath}.bak.${stamp(new Date())}`;
    await writeTextFile(backupPath, previous);
    backedUp = backupPath;
  }

  const at = new Date().toISOString();
  const body = `<!-- synced by Oh My Omop - Router persona ${input.name} v${input.version} at ${at} -->\n\n${input.soul.trim()}\n`;
  await writeTextFile(soulPath, body);
  const profilePath = join(profileDir, "SOUL.md");
  await writeTextFile(profilePath, body);
  await writeTextFile(join(profileDir, "persona.yaml"), `name: ${input.name}\nversion: "${input.version}"\nsyncedAt: "${at}"\nsource: ohmyomop-router\n`);
  return { home, soulPath, profilePath, backedUp, at };
}
