import { extname, isAbsolute, relative, resolve } from "node:path";
import { applySecurityHeaders } from "../api/errors.js";

const DEFAULT_DASHBOARD_DIST = resolve(process.cwd(), "dashboard", "dist");

/** Long-lived caching is only safe for Vite's content-hashed `assets/` output. */
const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";
/** Everything copied verbatim out of `public/` keeps its original filename. */
const PUBLIC_CACHE = "public, max-age=3600";
/** HTML shells must be revalidated so a redeploy is picked up immediately. */
const SHELL_CACHE = "no-cache";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
};

function contentType(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

function safeAssetPath(root: string, pathname: string): string | null {
  const candidate = resolve(root, pathname.replace(/^\/+/, ""));
  const withinRoot = relative(root, candidate);
  if (withinRoot === "" || withinRoot.startsWith("..") || isAbsolute(withinRoot)) return null;
  return candidate;
}

interface FileResponseOptions {
  readonly request?: Request;
  /** The public landing page must stay indexable; the console shell must not. */
  readonly indexable?: boolean;
}

async function fileResponse(
  path: string,
  cacheControl: string,
  options: FileResponseOptions = {},
): Promise<Response | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  const headers = new Headers({
    "cache-control": cacheControl,
    "content-type": contentType(path),
  });
  // Static responses used to ship with no security headers at all, leaving the
  // console HTML without a CSP or X-Frame-Options.
  applySecurityHeaders(headers, {
    request: options.request,
    html: path.endsWith(".html"),
    indexable: options.indexable,
  });
  return new Response(file, { headers });
}

function redirectResponse(location: string): Response {
  return new Response(null, {
    status: 308,
    headers: { location },
  });
}

/**
 * Paths owned by the backend API. These must never be answered with a file or
 * an HTML shell, otherwise the SPA fallback would shadow a JSON endpoint.
 */
function isApiPath(pathname: string): boolean {
  if (pathname.startsWith("/console/api/")) return true;
  // Share data endpoints sit under the same prefix as the share page.
  if (pathname.startsWith("/share/") && (pathname.endsWith("/data") || pathname.endsWith("/stream"))) {
    return true;
  }
  return false;
}

/**
 * Serves the compiled dashboard and its SPA fallback from the backend process.
 *
 * Resolution order:
 *  1. legacy `/dashboard*` → 308 redirect to `/console*`
 *  2. API namespaces → `null` (let the router answer)
 *  3. an existing file under the dist root (favicon, `when_yah/`, `providers/`, …)
 *  4. `/` → `landing.html`
 *  5. SPA shells for `/console*` and `/share*`
 *
 * @param request Incoming HTTP request.
 * @param distRoot Dashboard Vite output directory; injectable for isolated tests.
 * @returns A static response when the path belongs to the dashboard, otherwise null.
 */
export async function serveDashboardRequest(
  request: Request,
  distRoot: string = DEFAULT_DASHBOARD_DIST,
): Promise<Response | null> {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const url = new URL(request.url);
  const { pathname, search } = url;

  if (pathname === "/dashboard" || pathname.startsWith("/dashboard/")) {
    const suffix = pathname.slice("/dashboard".length) || "";
    return redirectResponse(`/console${suffix}${search}`);
  }

  if (isApiPath(pathname)) return null;

  // The console and share shells are private surfaces and must never be indexed;
  // everything else in the dist root is public marketing content.
  const indexable = !pathname.startsWith("/console") && !pathname.startsWith("/share");

  // A real file on disk always wins. Vite's hashed `assets/` output is immutable,
  // everything copied from `public/` keeps its name and gets a short cache.
  const asset = safeAssetPath(distRoot, pathname);
  if (asset !== null) {
    const immutable = pathname.startsWith("/assets/");
    const served = await fileResponse(
      asset,
      immutable ? IMMUTABLE_CACHE : pathname.endsWith(".html") ? SHELL_CACHE : PUBLIC_CACHE,
      { request, indexable },
    );
    if (served !== null) return served;
  }

  if (pathname === "/") {
    return fileResponse(resolve(distRoot, "landing.html"), SHELL_CACHE, { request, indexable: true });
  }
  if (pathname === "/console" || pathname.startsWith("/console/")) {
    return fileResponse(resolve(distRoot, "index.html"), SHELL_CACHE, { request });
  }
  if (pathname === "/share" || pathname.startsWith("/share/")) {
    return fileResponse(resolve(distRoot, "share.html"), SHELL_CACHE, { request });
  }
  return null;
}
