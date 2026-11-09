import { describe, expect, test } from "vitest";
import { detectBackupKind } from "../../../src/features/settings/page";

describe("detectBackupKind", () => {
  test("accepts an Oh My Omop - Router backup object with tables", () => {
    expect(detectBackupKind({ app: "ohmyomop-router", tables: { settings: [] } })).toBe("restore");
  });

  test("rejects malformed, unrelated, and array payloads", () => {
    expect(detectBackupKind(null)).toBeNull();
    expect(detectBackupKind([])).toBeNull();
    expect(detectBackupKind({ app: "other", tables: {} })).toBeNull();
    expect(detectBackupKind({ app: "ohmyomop-router", tables: null })).toBeNull();
  });
});
