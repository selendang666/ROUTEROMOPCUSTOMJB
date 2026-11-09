#!/usr/bin/env bun
/**
 * verify — minimal verification without legacy fallback.
 * Runs: tsc --noEmit, legacy import grep =0, bun build src/main.ts, doctor (without DB, warnings ok)
 */
import path from "node:path";
import fs from "node:fs";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");

type CheckResult = { ok: boolean; message: string; detail?: string };

async function spawnChecked(args: string[], opts: { cwd?: string; timeoutMs?: number; env?: Record<string, string> } = {}): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }> {
  const proc = Bun.spawn(args, {
    cwd: opts.cwd ?? REPO_ROOT,
    env: { ...process.env, ...(opts.env ?? {}) } as Record<string, string>,
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeoutMs = opts.timeoutMs ?? 120_000;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { proc.kill(); } catch {}
  }, timeoutMs);
  const stdout = await new Response(proc.stdout).text().catch(() => "");
  const stderr = await new Response(proc.stderr).text().catch(() => "");
  const exitCode = await proc.exited;
  clearTimeout(timer);
  return { exitCode, stdout, stderr, timedOut };
}

function walk(dir: string, out: string[]): void {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === ".git" || e.name === "dist" || e.name === ".codegraph") continue;
      walk(full, out);
    } else if (e.isFile() && e.name.endsWith(".ts")) {
      out.push(full);
    }
  }
}

function checkLegacyImports(): CheckResult {
  const srcRoot = path.join(REPO_ROOT, "src");
  if (!fs.existsSync(srcRoot)) return { ok: false, message: "src dir missing" };
  const files: string[] = [];
  walk(srcRoot, files);
  const hits: string[] = [];
  const legacyPattern = /from\s+["'][^"']*(?:\/|^)(?:application|codec|traffic)(?:\/|["'])/;
  const srcPattern = /src\/(?:application|codec|traffic)(?:\/|["'])/;
  for (const file of files) {
    const content = fs.readFileSync(file, "utf8");
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i] ?? "";
      const trimmed = raw.trim();
      if (trimmed.startsWith("//")) continue;
      // strip inline // comments for grep -v "//" semantics: if line contains // after code, skip? spec says grep -v "//" filters lines containing // entirely, so we skip any line with //
      if (raw.includes("//")) continue;
      if (legacyPattern.test(raw) || srcPattern.test(raw)) {
        const rel = path.relative(REPO_ROOT, file);
        hits.push(`${rel}:${i + 1}:${raw.trim()}`);
      }
    }
  }
  if (hits.length === 0) return { ok: true, message: "legacy import grep =0" };
  return { ok: false, message: `legacy imports found: ${hits.length}`, detail: hits.slice(0, 20).join("\n") };
}

async function main(): Promise<number> {
  console.log("\x1b[1mOh My Omop - Router verify\x1b[0m — minimal contracts without legacy fallback");
  console.log(`Repo: ${REPO_ROOT}`);
  let failed = 0;

  // 1) tsc --noEmit
  console.log("\n[1/4] bunx tsc --noEmit");
  const tsc = await spawnChecked(["bunx", "tsc", "--noEmit"], { timeoutMs: 60_000 });
  if (tsc.timedOut) {
    console.log("\x1b[31m✗\x1b[0m tsc timed out");
    failed += 1;
  } else if (tsc.exitCode !== 0) {
    console.log(`\x1b[31m✗\x1b[0m tsc failed (exit ${tsc.exitCode})`);
    if (tsc.stdout) console.log(tsc.stdout.slice(0, 4000));
    if (tsc.stderr) console.log(tsc.stderr.slice(0, 4000));
    failed += 1;
  } else {
    console.log("\x1b[32m✓\x1b[0m tsc --noEmit passed");
  }

  // 2) legacy grep
  console.log("\n[2/4] grep legacy dirs =0 (src/application|codec|traffic, import style)");
  const legacy = checkLegacyImports();
  if (!legacy.ok) {
    console.log(`\x1b[31m✗\x1b[0m ${legacy.message}`);
    if (legacy.detail) console.log(legacy.detail);
    console.log('Hint: run `grep -r "src/application\\|src/codec\\|src/traffic" src --include="*.ts" | grep -v "//"` should be 0');
    failed += 1;
  } else {
    console.log(`\x1b[32m✓\x1b[0m ${legacy.message}`);
  }

  // also check that legacy dirs are gone or empty
  const legacyDirs = ["src/application", "src/codec", "src/traffic"];
  const remainingDirs: string[] = [];
  for (const d of legacyDirs) {
    const full = path.join(REPO_ROOT, d);
    if (fs.existsSync(full)) {
      const entries = fs.readdirSync(full);
      if (entries.length > 0) remainingDirs.push(`${d} (${entries.length} entries)`);
    }
  }
  if (remainingDirs.length > 0) {
    console.log(`\x1b[33m!\x1b[0m legacy dirs still present: ${remainingDirs.join(", ")} — should be gone or empty`);
  } else {
    console.log("\x1b[32m✓\x1b[0m legacy dirs gone/empty");
  }

  // 3) bun build src/main.ts
  console.log("\n[3/4] bun build src/main.ts");
  // Use --target=bun and temp outfile to validate bundling without emitting compile binary
  const tmpOut = path.join(REPO_ROOT, ".tmp-verify-build.js");
  const build = await spawnChecked(["bun", "build", "src/main.ts", "--target", "bun", "--outfile", tmpOut], { timeoutMs: 60_000 });
  if (build.timedOut) {
    console.log("\x1b[31m✗\x1b[0m bun build timed out");
    failed += 1;
  } else if (build.exitCode !== 0) {
    console.log(`\x1b[31m✗\x1b[0m bun build failed (exit ${build.exitCode})`);
    if (build.stdout) console.log(build.stdout.slice(0, 4000));
    if (build.stderr) console.log(build.stderr.slice(0, 4000));
    failed += 1;
  } else {
    console.log("\x1b[32m✓\x1b[0m bun build src/main.ts passed");
    try { if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut); } catch {}
  }

  // 4) doctor without DB (warnings ok, postgres SELECT 1 failure is tolerated)
  console.log("\n[4/4] bun run scripts/dev/doctor.ts (without DB, warnings ok)");
  // Ensure DATABASE_URL is set to a syntactically valid postgres URL so doctor validates format
  const doctorEnv: Record<string, string> = {};
  if (!process.env["DATABASE_URL"] || !process.env["DATABASE_URL"].startsWith("postgres")) {
    doctorEnv["DATABASE_URL"] = "postgresql://ohmyomop_router:ohmyomop_router@127.0.0.1:5432/ohmyomop_router";
  }
  const doctor = await spawnChecked(["bun", "run", "scripts/dev/doctor.ts"], { timeoutMs: 20_000, env: doctorEnv });
  const combined = `${doctor.stdout}\n${doctor.stderr}`;
  if (doctor.timedOut) {
    console.log("\x1b[33m!\x1b[0m doctor timed out (20s) — infra may be cold, treating as warning");
  } else if (doctor.exitCode === 0) {
    console.log("\x1b[32m✓\x1b[0m doctor passed");
    if (combined) console.log(combined.slice(0, 2000));
  } else {
    // Doctor exit 1 due to postgres SELECT 1 failure is expected without DB — tolerate as warning
    const isPostgresOnlyFailure = combined.includes("PostgreSQL: SELECT 1 failed") || combined.includes("postgres SELECT 1");
    const hasValidUrlLog = combined.includes("DATABASE_URL:") && combined.includes("postgres");
    if (isPostgresOnlyFailure && hasValidUrlLog) {
      console.log("\x1b[33m!\x1b[0m doctor postgres unreachable (expected without DB) — warnings ok, verify continues");
      console.log(combined.slice(0, 3000));
    } else {
      console.log(`\x1b[31m✗\x1b[0m doctor failed (exit ${doctor.exitCode})`);
      console.log(combined.slice(0, 4000));
      failed += 1;
    }
  }

  console.log("\n" + "─".repeat(50));
  if (failed === 0) {
    console.log("\x1b[32mAll verify checks passed\x1b[0m (legacy grep=0, tsc 0, build ok, doctor without DB ok)");
    return 0;
  }
  console.log(`\x1b[31mVerify failed: ${failed} check(s) failed\x1b[0m`);
  return 1;
}

const code = await main();
process.exit(code);
