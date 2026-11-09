/**
 * Coolify client unit tests — pure helpers plus fetch-level behavior with a
 * stubbed global fetch. No network, no database.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  getApplication,
  getProject,
  listApplications,
  listProjects,
  normalizeApplication,
  normalizeBaseUrl,
  normalizeService,
  probeConnection,
  validateConnectionInput,
} from "./client.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("normalizeBaseUrl", () => {
  test("keeps a plain origin root", () => {
    expect(normalizeBaseUrl("https://coolify.example.com")).toBe("https://coolify.example.com");
  });

  test("strips trailing slashes and pasted API suffixes", () => {
    expect(normalizeBaseUrl("https://coolify.example.com/")).toBe("https://coolify.example.com");
    expect(normalizeBaseUrl("https://coolify.example.com/api/v1")).toBe("https://coolify.example.com");
    expect(normalizeBaseUrl("https://coolify.example.com/api/v1/projects")).toBe("https://coolify.example.com");
  });

  test("rejects non-URL and non-http(s) input", () => {
    expect(() => normalizeBaseUrl("")).toThrow("required");
    expect(() => normalizeBaseUrl("not-a-url")).toThrow("valid http");
    expect(() => normalizeBaseUrl("ftp://coolify.example.com")).toThrow("http:// or https://");
  });
});

describe("validateConnectionInput", () => {
  test("normalizes a valid form", () => {
    const out = validateConnectionInput({
      name: "  homelab  ",
      baseUrl: "https://coolify.example.com/api/v1/",
      apiToken: "1|secret",
    });
    expect(out).toEqual({ name: "homelab", baseUrl: "https://coolify.example.com", apiToken: "1|secret" });
  });

  test("rejects missing fields", () => {
    expect(() => validateConnectionInput({ baseUrl: "https://x.example", apiToken: "1|s" })).toThrow("name");
    expect(() => validateConnectionInput({ name: "x", apiToken: "1|s" })).toThrow("baseUrl");
    expect(() => validateConnectionInput({ name: "x", baseUrl: "https://x.example" })).toThrow("apiToken");
  });
});

describe("normalizers", () => {
  test("normalizeApplication maps snake_case with fallbacks", () => {
    const app = normalizeApplication(
      { uuid: "app-1", name: "web", fqdn: "https://web.example.com", git_repository: "org/repo", git_branch: "main", build_pack: "nixpacks", status: "running:healthy" },
      "proj-1",
      "production",
    );
    expect(app.uuid).toBe("app-1");
    expect(app.gitRepository).toBe("org/repo");
    expect(app.projectUuid).toBe("proj-1");
    expect(app.environmentName).toBe("production");
  });

  test("normalizeService falls back to unnamed", () => {
    const svc = normalizeService({ uuid: "svc-1" }, null, null);
    expect(svc.name).toBe("(unnamed)");
    expect(svc.uuid).toBe("svc-1");
  });
});

describe("listProjects", () => {
  test("attaches Bearer auth and skips rows without uuid", async () => {
    let seenAuth: string | null = null;
    let seenUrl = "";
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      seenUrl = String(url);
      seenAuth = new Headers(init?.headers).get("authorization");
      return jsonResponse([{ uuid: "p1", name: "shop" }, { name: "no-uuid" }]);
    }) as typeof fetch;
    const projects = await listProjects("https://coolify.example.com", "1|secret");
    expect(seenUrl).toBe("https://coolify.example.com/api/v1/projects");
    expect(seenAuth).toBe("Bearer 1|secret");
    expect(projects.map((p) => p.uuid)).toEqual(["p1"]);
  });

  test("maps 401 to an invalid-token error", async () => {
    globalThis.fetch = (async () => jsonResponse({ message: "Invalid token." }, 401)) as typeof fetch;
    await expect(listProjects("https://coolify.example.com", "bad")).rejects.toThrow("Invalid Coolify token");
  });

  test("maps unreachable hosts to an unreachable error", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    await expect(listProjects("https://coolify.example.com", "1|s")).rejects.toThrow("unreachable");
  });
});

describe("getProject", () => {
  test("flattens applications nested under environments", async () => {
    globalThis.fetch = (async () =>
      jsonResponse({
        uuid: "p1",
        name: "shop",
        environments: [
          {
            id: 1,
            name: "production",
            applications: [{ uuid: "a1", name: "web", status: "running" }],
            services: [{ uuid: "s1", name: "redis", status: "running" }],
          },
        ],
      })) as typeof fetch;
    const detail = await getProject("https://coolify.example.com", "1|s", "p1");
    expect(detail.environments?.map((e) => e.name)).toEqual(["production"]);
    expect(detail.applications?.map((a) => a.uuid)).toEqual(["a1"]);
    expect(detail.applications?.[0]?.environmentName).toBe("production");
    expect(detail.services?.map((s) => s.uuid)).toEqual(["s1"]);
  });
});

describe("listApplications / getApplication", () => {
  test("listApplications normalizes rows", async () => {
    globalThis.fetch = (async () => jsonResponse([{ uuid: "a1", name: "web" }])) as typeof fetch;
    const apps = await listApplications("https://coolify.example.com", "1|s");
    expect(apps).toHaveLength(1);
    expect(apps[0]?.name).toBe("web");
  });

  test("getApplication unwraps the versioned envelope", async () => {
    globalThis.fetch = (async () =>
      jsonResponse({ application: { uuid: "a1", name: "web", status: "running" } })) as typeof fetch;
    const app = await getApplication("https://coolify.example.com", "1|s", "a1");
    expect(app.uuid).toBe("a1");
    expect(app.status).toBe("running");
  });
});

describe("probeConnection", () => {
  test("returns ok with team name and never throws", async () => {
    globalThis.fetch = (async (url: string | URL | Request) => {
      if (String(url).endsWith("/teams/current")) return jsonResponse({ name: "homelab" });
      return jsonResponse("v4.0.0");
    }) as typeof fetch;
    const probe = await probeConnection("https://coolify.example.com", "1|s");
    expect(probe.ok).toBe(true);
    expect(probe.team).toBe("homelab");
    expect(probe.version).toBe("v4.0.0");
  });

  test("maps bad token to ok:false with message", async () => {
    globalThis.fetch = (async () => jsonResponse({ message: "Invalid token." }, 401)) as typeof fetch;
    const probe = await probeConnection("https://coolify.example.com", "bad");
    expect(probe.ok).toBe(false);
    expect(probe.error).toMatch(/Invalid Coolify token/);
  });
});
