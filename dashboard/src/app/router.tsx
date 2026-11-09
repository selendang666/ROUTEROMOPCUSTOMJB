import { createBrowserRouter, Navigate, redirect } from "react-router-dom";
import type { ComponentType } from "react";
import { AppShell } from "./layout";
import { LoginPage } from "../features/login/page";
import { BannedPage } from "../features/banned/page";
import { RouteError } from "./route-error";

export async function guardLoader({ request }: { request: Request }): Promise<Response | null> {
  try {
    const res = await fetch("/console/api/session", { credentials: "same-origin" });
    if (res.status === 403) return redirect("/banned");
    if (res.status === 401) {
      const next = new URL(request.url).pathname.replace(/^\/console/, "") || "/overview";
      return redirect(`/login?next=${encodeURIComponent(next)}`);
    }
    return null;
  } catch {
    // Gateway unreachable — don't blank the console, show login with next
    const next = new URL(request.url).pathname.replace(/^\/console/, "") || "/overview";
    return redirect(`/login?next=${encodeURIComponent(next)}`);
  }
}

export async function loginLoader({ request }: { request: Request }): Promise<Response | null> {
  try {
    const res = await fetch("/console/api/session", { credentials: "same-origin" });
    if (res.status === 403) return redirect("/banned");
    if (res.ok) {
      const url = new URL(request.url);
      const next = url.searchParams.get("next") || "/overview";
      const dest = next.startsWith("/") ? next : `/${next}`;
      return redirect(dest);
    }
    return null;
  } catch {
    // If gateway unreachable, still show login — don't blank
    return null;
  }
}

/**
 * Chunk filenames carry a content hash, so a tab left open across a rebuild
 * asks for a chunk the server no longer has. That surfaces as "Failed to fetch
 * dynamically imported module". Reloading picks up the fresh entry point.
 *
 * The guard is a timestamp, not a one-shot flag: a flag that latches for the
 * whole session would block every later recovery, leaving the user to refresh
 * by hand. Only a reload within the cooldown suppresses another one, which is
 * enough to stop a genuinely broken chunk from looping.
 */
const RELOAD_STAMP = "ohmyomop-router:chunk-reload-at";
const RELOAD_COOLDOWN_MS = 10_000;

function reloadedRecently(): boolean {
  const raw = sessionStorage.getItem(RELOAD_STAMP);
  if (!raw) return false;
  const at = Number(raw);
  return Number.isFinite(at) && Date.now() - at < RELOAD_COOLDOWN_MS;
}

function lazyPage<M>(load: () => Promise<M>, pick: (module: M) => ComponentType) {
  return async () => {
    try {
      const module = await load();
      sessionStorage.removeItem(RELOAD_STAMP);
      return { Component: pick(module) };
    } catch (error) {
      if (reloadedRecently()) throw error;
      sessionStorage.setItem(RELOAD_STAMP, String(Date.now()));
      // The URL has not committed yet when a lazy route fails, so reloading
      // in place would strand the user on the page they were leaving. The
      // pending navigation carries the real destination — already basename
      // qualified, dynamic segments included — so the fresh document lands
      // where they clicked.
      // Cache-bust: the browser may hold a stale index.html with old chunk
      // hashes. Appending a timestamp forces a fresh fetch so the new chunks
      // are referenced correctly.
      const bust = `_bust=${Date.now()}`;
      const pending = router.state.navigation.location;
      if (pending) {
        const sep = pending.search ? "&" : "?";
        window.location.assign(`${pending.pathname}${pending.search}${sep}${bust}${pending.hash}`);
      } else {
        window.location.assign(`${location.pathname}?${bust}`);
      }
      // The document swap supersedes this navigation, so never settle.
      return new Promise<never>(() => {});
    }
  };
}

export const router = createBrowserRouter(
  [
    { path: "/banned", element: <BannedPage />, errorElement: <RouteError /> },
    { path: "/login", element: <LoginPage />, loader: loginLoader, errorElement: <RouteError /> },
    {
      path: "/",
      element: <AppShell />,
      loader: guardLoader,
      errorElement: <RouteError />,
      children: [
        { index: true, element: <Navigate to="/overview" replace /> },
        { path: "overview", lazy: lazyPage(() => import("../features/overview/page"), (m) => m.OverviewPage) },
        { path: "usage", lazy: lazyPage(() => import("../features/usage/page"), (m) => m.UsagePage) },
        { path: "providers", lazy: lazyPage(() => import("../features/providers/page"), (m) => m.ProvidersPage) },
        { path: "providers/custom/:id", lazy: lazyPage(() => import("../features/providers/custom-detail"), (m) => m.CustomProviderDetailPage) },
        { path: "providers/:id", lazy: lazyPage(() => import("../features/providers/detail"), (m) => m.ProviderDetailPage) },
        { path: "combos-routes", lazy: lazyPage(() => import("../features/combos/page"), (m) => m.CombosPage) },
        { path: "buyers", lazy: lazyPage(() => import("../features/buyers/page"), (m) => m.BuyersPage) },        { path: "combos", element: <Navigate to="/combos-routes" replace /> },
        { path: "quota", lazy: lazyPage(() => import("../features/quota/page"), (m) => m.QuotaPage) },
        { path: "proxy-requests", lazy: lazyPage(() => import("../features/proxy-requests/page"), (m) => m.ProxyRequestsPage) },
        { path: "console-log", lazy: lazyPage(() => import("../features/console-log/page"), (m) => m.ConsoleLogPage) },
        { path: "performance", element: <Navigate to="/usage" replace /> },
        { path: "customization", lazy: lazyPage(() => import("../features/customization/page"), (m) => m.CustomizationPage) },
        { path: "filter-sanitize", lazy: lazyPage(() => import("../features/filter-sanitize/page"), (m) => m.FilterSanitizePage) },
        { path: "token-saver", lazy: lazyPage(() => import("../features/token-saver/page"), (m) => m.TokenSaverPage) },
        { path: "cli-tools", lazy: lazyPage(() => import("../features/cli-tools/page"), (m) => m.CliToolsPage) },
        { path: "cli-tools/:toolId", lazy: lazyPage(() => import("../features/cli-tools/detail"), (m) => m.CliToolDetailPage) },
        { path: "persona-playground", lazy: lazyPage(() => import("../features/persona-playground/page"), (m) => m.PersonaPlaygroundPage) },
        { path: "playground", lazy: lazyPage(() => import("../features/playground/page"), (m) => m.PlaygroundPage) },
        { path: "coolify", lazy: lazyPage(() => import("../features/coolify/page"), (m) => m.CoolifyPage) },
        { path: "coolify/:connectionId/projects/:uuid", lazy: lazyPage(() => import("../features/coolify/detail"), (m) => m.CoolifyProjectDetailPage) },
        { path: "coolify/:connectionId/applications/:uuid", lazy: lazyPage(() => import("../features/coolify/detail"), (m) => m.CoolifyApplicationDetailPage) },
        { path: "settings", lazy: lazyPage(() => import("../features/settings/page"), (m) => m.SettingsPage) },
      ],
    },
  ],
  { basename: "/console" },
);
