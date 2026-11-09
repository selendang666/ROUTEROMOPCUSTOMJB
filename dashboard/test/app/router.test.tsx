import { describe, expect, test, vi } from "vitest";
import { guardLoader, router } from "../../src/app/router";

describe("dashboard router", () => {
  test("guards protected routes and preserves destination", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 401 })));
    const result = await guardLoader({ request: new Request("http://localhost/console/providers?tab=models") });
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).headers.get("location")).toBe("/login?next=%2Fproviders");
  });

  test("allows authenticated route loads", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 200 })));
    await expect(guardLoader({ request: new Request("http://localhost/console/overview") })).resolves.toBeNull();
  });

  test("keeps canonical console sections and advanced routes registered", () => {
    const shell = router.routes.find((route) => route.path === "/");
    const children = shell?.children ?? [];
    const paths = children.map((route) => route.path).filter((path): path is string => typeof path === "string");

    expect(paths).toEqual(expect.arrayContaining([
      "overview",
      "usage",
      "providers",
      "combos",
      "quota",
      "proxy-requests",
      "console-log",
      "settings",
      "customization",
      "filter-sanitize",
      "token-saver",
      "cli-tools",
      "cli-tools/:toolId",
      "playground",
    ]));
  });

  test("does not register retired legacy routes", () => {
    const shell = router.routes.find((route) => route.path === "/");
    const paths = shell?.children?.map((route) => route.path) ?? [];

    expect(paths).not.toContain("advanced");
    expect(paths).not.toContain("advanced/filter-sanitize");
    expect(paths).not.toContain("advanced/token-saver");
    expect(paths).not.toContain("advanced/cli-tools");
    expect(paths).not.toContain("model-studio");
    expect(paths).not.toContain("advanced/warp");
    expect(paths).not.toContain("advanced/automation");
    expect(paths).not.toContain("advanced/db-map");
    expect(paths).not.toContain("warp");
    expect(paths).not.toContain("db-map");
  });
});
