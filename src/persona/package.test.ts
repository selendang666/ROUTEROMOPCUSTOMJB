import { describe, expect, test } from "bun:test";
import { buildPersonaZip, parsePersonaZip, PersonaPackError } from "./package.js";

const MANIFEST = "name: hemress\nversion: \"3\"\n";
const SOUL = "# Hemress\nYou are Hemress.";

function pack(files: Record<string, string>): Uint8Array {
  return buildPersonaZip(files);
}

function expectPackError(bytes: Uint8Array, reason: string): void {
  try {
    parsePersonaZip(bytes);
  } catch (error) {
    expect(error).toBeInstanceOf(PersonaPackError);
    expect((error as PersonaPackError).reason).toBe(reason);
    return;
  }
  throw new Error("expected PersonaPackError");
}

describe("parsePersonaZip", () => {
  test("accepts a valid pack and assembles content in order", () => {
    const out = parsePersonaZip(
      pack({ "persona.yaml": MANIFEST, "SOUL.md": SOUL, "files/b.md": "B", "files/a.md": "A" }),
    );
    expect(out.manifest).toEqual({ name: "hemress", version: "3" });
    expect(out.extras.map((e) => e.path)).toEqual(["files/a.md", "files/b.md"]);
    expect(out.content).toContain(SOUL);
    expect(out.content.indexOf("files/a.md")).toBeLessThan(out.content.indexOf("files/b.md"));
  });

  test("defaults version to 1 and ignores non-files entries", () => {
    const out = parsePersonaZip(pack({ "persona.yaml": "name: x\n", "SOUL.md": "soul", "notes.txt": "ignored" }));
    expect(out.manifest.version).toBe("1");
    expect(out.extras).toEqual([]);
  });

  test("rejects missing manifest, missing soul, bad names, traversal, types", () => {
    expectPackError(pack({ "SOUL.md": SOUL }), "missing_file");
    expectPackError(pack({ "persona.yaml": MANIFEST }), "missing_file");
    expectPackError(pack({ "persona.yaml": "name: ''\n", "SOUL.md": SOUL }), "bad_manifest");
    expectPackError(pack({ "persona.yaml": "name: bad name!\n", "SOUL.md": SOUL }), "bad_manifest");
    expectPackError(pack({ "persona.yaml": MANIFEST, "SOUL.md": SOUL, "../evil.md": "x" }), "unsafe_path");
    expectPackError(pack({ "persona.yaml": MANIFEST, "SOUL.md": SOUL, "run.exe": "x" }), "bad_type");
    expectPackError(pack({ "persona.yaml": MANIFEST, "SOUL.md": SOUL, "files/a.md": "A", "files\\a.md": "dup" }), "unsafe_path");
  });

  test("rejects empty and non-zip input", () => {
    expectPackError(new Uint8Array(0), "empty");
    expectPackError(new TextEncoder().encode("not a zip"), "bad_zip");
  });
});
