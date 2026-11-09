import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hermesHome, syncPersonaToHermes } from "./hermes-sync.js";
import { readTextFile, writeTextFile } from "../console/cli-tools/fs-ops.js";

const ENV_KEY = "OHMYOMOP_ROUTER_HERMES_HOME";
const saved = process.env[ENV_KEY];

afterEach(() => {
  if (saved === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = saved;
});

describe("hermes sync", () => {
  test("resolves home from env override", () => {
    process.env[ENV_KEY] = "/tmp/hermes-test-home";
    expect(hermesHome()).toBe("/tmp/hermes-test-home");
  });

  test("writes soul, profile copy and backs up the previous soul", async () => {
    const home = mkdtempSync(join(tmpdir(), "hermes-home-"));
    process.env[ENV_KEY] = home;
    await writeTextFile(join(home, "SOUL.md"), "Old soul");
    const result = await syncPersonaToHermes({ name: "hemress", version: "3", soul: "New soul" });
    expect(result.home).toBe(home);
    expect(result.backedUp).not.toBeNull();
    expect(await readTextFile(result.backedUp!)).toBe("Old soul");
    const soul = (await readTextFile(join(home, "SOUL.md")))!;
    expect(soul).toContain("New soul");
    expect(soul).toContain("hemress");
    expect(await readTextFile(join(home, "persona", "hemress", "persona.yaml"))).toContain("hemress");
  });

  test("works on an empty home without backup", async () => {
    const home = mkdtempSync(join(tmpdir(), "hermes-empty-"));
    process.env[ENV_KEY] = home;
    const result = await syncPersonaToHermes({ name: "n", version: "1", soul: "s" });
    expect(result.backedUp).toBeNull();
    expect((await readTextFile(join(home, "SOUL.md")))!).toContain("s");
  });
});
