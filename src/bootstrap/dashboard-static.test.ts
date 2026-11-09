import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveDashboardRequest } from "./dashboard-static.js";

describe("dashboard static serving", () => {
  test("redirects the legacy dashboard path to the console basename", async () => {
    const response = await serveDashboardRequest(new Request("http://localhost/dashboard?next=1"));

    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe("/console?next=1");
  });

  test("serves the console shell, root assets, and SPA fallback", async () => {
    const root = await mkdtemp(join(tmpdir(), "ohmyomop-router-dashboard-"));
    try {
      await writeFile(join(root, "index.html"), "console shell");
      await writeFile(join(root, "landing.html"), "landing shell");
      await mkdir(join(root, "assets"));
      await writeFile(join(root, "assets", "app.js"), "console asset");

      const shell = await serveDashboardRequest(new Request("http://localhost/console/overview"), root);
      const asset = await serveDashboardRequest(new Request("http://localhost/assets/app.js"), root);
      const landing = await serveDashboardRequest(new Request("http://localhost/"), root);

      expect(await shell?.text()).toBe("console shell");
      expect(shell?.headers.get("cache-control")).toBe("no-cache");
      expect(await asset?.text()).toBe("console asset");
      expect(asset?.headers.get("cache-control")).toContain("immutable");
      expect(await landing?.text()).toBe("landing shell");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("does not serve console API paths as frontend HTML", async () => {
    const response = await serveDashboardRequest(new Request("http://localhost/console/api/logs"));

    expect(response).toBeNull();
  });

  test("serves nested public assets with the right content type", async () => {
    const root = await mkdtemp(join(tmpdir(), "ohmyomop-router-dashboard-"));
    try {
      await writeFile(join(root, "favicon.webp"), "icon");
      await mkdir(join(root, "when_yah"));
      await writeFile(join(root, "when_yah", "hero.webp"), "hero");
      await mkdir(join(root, "providers"));
      await writeFile(join(root, "providers", "anthropic.svg"), "<svg/>");

      const icon = await serveDashboardRequest(new Request("http://localhost/favicon.webp"), root);
      const hero = await serveDashboardRequest(new Request("http://localhost/when_yah/hero.webp"), root);
      const logo = await serveDashboardRequest(
        new Request("http://localhost/providers/anthropic.svg"),
        root,
      );

      expect(await icon?.text()).toBe("icon");
      expect(icon?.headers.get("content-type")).toBe("image/webp");
      expect(await hero?.text()).toBe("hero");
      expect(hero?.headers.get("content-type")).toBe("image/webp");
      // Files copied from `public/` are not content-hashed, so they must not be immutable.
      expect(hero?.headers.get("cache-control")).not.toContain("immutable");
      expect(logo?.headers.get("content-type")).toBe("image/svg+xml");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("falls back to the share shell without shadowing share data endpoints", async () => {
    const root = await mkdtemp(join(tmpdir(), "ohmyomop-router-dashboard-"));
    try {
      await writeFile(join(root, "share.html"), "share shell");

      const page = await serveDashboardRequest(new Request("http://localhost/share/abc123"), root);
      const data = await serveDashboardRequest(
        new Request("http://localhost/share/abc123/data"),
        root,
      );
      const setupData = await serveDashboardRequest(
        new Request("http://localhost/share/setup/abc123/data"),
        root,
      );

      expect(await page?.text()).toBe("share shell");
      expect(page?.headers.get("cache-control")).toBe("no-cache");
      expect(data).toBeNull();
      expect(setupData).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("leaves unknown non-frontend paths to the API", async () => {
    const response = await serveDashboardRequest(new Request("http://localhost/v1/models"));

    expect(response).toBeNull();
  });

  test("applies security headers to static responses", async () => {
    const root = await mkdtemp(join(tmpdir(), "ohmyomop-router-dashboard-"));
    try {
      await writeFile(join(root, "index.html"), "console shell");
      await writeFile(join(root, "landing.html"), "landing shell");
      await mkdir(join(root, "assets"));
      await writeFile(join(root, "assets", "app.js"), "console asset");

      const shell = await serveDashboardRequest(new Request("https://localhost/console/overview"), root);
      const landing = await serveDashboardRequest(new Request("https://localhost/"), root);
      const asset = await serveDashboardRequest(new Request("https://localhost/assets/app.js"), root);

      // HTML shells are framed-denied and CSP-scoped.
      expect(shell?.headers.get("x-frame-options")).toBe("DENY");
      expect(shell?.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
      // The console must stay out of search indexes...
      expect(shell?.headers.get("x-robots-tag")).toBe("noindex, nofollow");
      // ...but the public landing page must not be deindexed.
      expect(landing?.headers.get("x-robots-tag")).toBeNull();
      expect(landing?.headers.get("x-frame-options")).toBe("DENY");
      // Non-HTML assets still get the baseline hardening.
      expect(asset?.headers.get("x-content-type-options")).toBe("nosniff");
      // HSTS is emitted for HTTPS requests.
      expect(shell?.headers.get("strict-transport-security")).toContain("max-age=");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("the CSP allow-lists the Google Fonts origins the console shell loads", async () => {
    const root = await mkdtemp(join(tmpdir(), "ohmyomop-router-dashboard-"));
    try {
      await writeFile(join(root, "index.html"), "console shell");

      const shell = await serveDashboardRequest(new Request("https://localhost/console"), root);
      const csp = shell?.headers.get("content-security-policy") ?? "";

      expect(csp).toContain("https://fonts.googleapis.com");
      expect(csp).toContain("https://fonts.gstatic.com");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
