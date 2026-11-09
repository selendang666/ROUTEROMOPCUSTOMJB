import { describe, expect, test } from "vitest";
import { NAV_GROUPS, TITLES } from "../../src/app/navigation";

describe("dashboard navigation metadata", () => {
  test("keeps every navigable sidebar path unique", () => {
    const paths = [...NAV_GROUPS]
      .flatMap((group) => group.items.map((item) => item.to))
      .filter(Boolean);

    expect(new Set(paths).size).toBe(paths.length);
  });

  test("keeps navigation paths and titles aligned at root", () => {
    const allPaths = NAV_GROUPS.flatMap((group) => group.items.map((item) => item.to));

    expect(allPaths.every((path) => TITLES[path] !== undefined)).toBe(true);
    expect(TITLES["/cli-tools/:toolId"]).toMatchObject({ title: "CLI Tool" });
    expect(TITLES["/filter-sanitize"]).toMatchObject({ title: "Filter Sanitize" });
    // No advanced prefix must remain in any title key
    expect(Object.keys(TITLES).every((key) => !key.startsWith("/advanced"))).toBe(true);
  });
});
