/**
 * Centralized React Query key factories.
 *
 * Every query/invalidation site in the dashboard should source its key from
 * here so that:
 *   1. the `queryKey` passed to `useQuery` and the one passed to
 *      `invalidateQueries` can never drift apart;
 *   2. renaming a key is a single-file change;
 *   3. invalidating a whole family by prefix is a one-liner
 *      (`invalidateQueries({ queryKey: qk.settings.all })`).
 *
 * Keys are `readonly` tuples — treat them as opaque, never mutate.
 */

/** Root prefixes used across the dashboard, grouped by domain. */
export const qk = {
  /** `/console/api/settings` — runtime + appearance settings bundle. */
  settings: {
    all: ["settings"] as const,
  },

  /** `/console/api/keys` — proxy API keys. */
  apiKeys: {
    all: ["keys"] as const,
  },

  /** `/console/api/buyers` — opencode buyer keys + licenses. */
  buyers: {
    all: ["buyers"] as const,
  },

  /** `/console/api/overview` — dashboard overview aggregate. */
  overview: {
    all: ["overview"] as const,
  },


  /** `/console/api/health/*` — proxy/runtime health probes. */
  health: {
    status: ["health-status"] as const,
    metrics: ["health-metrics"] as const,
  },

  /** GitHub repository branch heads (main/dev). */
  releases: {
    githubLatest: ["github-latest-release"] as const,
    githubBranches: ["github-repository-branches"] as const,
  },

  /** `/console/api/providers` — single provider family (includes custom providers via client filter). */
  providers: {
    all: ["providers"] as const,
    detail: (providerId: string | undefined) => ["providers", providerId] as const,
    accounts: (providerId: string | undefined) => ["providers", providerId, "accounts"] as const,
    customAll: ["providers", "custom"] as const,
    customDetail: (providerId: string | undefined) => ["providers", "custom", providerId] as const,
  },

  /** `/console/api/models/aliases` + `/console/api/models/combos`. */
  aliases: {
    all: ["console", "aliases"] as const,
  },
  combos: {
    all: ["console", "combos"] as const,
  },

  /** `/console/api/proxies` pool and transient search results. */
  proxies: {
    all: ["console", "proxies"] as const,
  },
  proxySettings: {
    all: ["console", "proxy-settings"] as const,
  },

  /** `/console/api/wireguard/status` — WireGuard SOCKS5 bridge status. */
  wireguard: {
    status: ["wireguard", "status"] as const,
  },

  /** `/console/api/settings` — web search routing is now consolidated into settings. */
  webSearchRouting: {
    all: ["console", "web-search-routing"] as const,
  },

  /** `/console/api/filters` — request filter/sanitize rules. */
  filterRules: {
    all: ["filter-rules"] as const,
  },

  /** `/console/api/quota` management. */
  quota: {
    management: ["console", "quota-management"] as const,
    account: (accountId: string) => ["console", "quota-account", accountId] as const,
  },

  /** `/console/api/usage/*`. */
  usage: {
    chart: (period: string) => ["usage-chart", period] as const,
    detail: (id: string | null) => ["usage-detail", id] as const,
    by: (period: string, dimension: string) => ["usage-by", period, dimension] as const,
    cache: (period: string) => ["usage-cache", period] as const,
    summary: (period: string) => ["usage-summary", period] as const,
    recentRequests: ["usage-requests", "recent"] as const,
  },
  /** `/console/api/cli-tools/*`. */
  cliTools: {
    registry: ["cli-tools", "registry"] as const,
    statuses: ["cli-tools", "statuses"] as const,
    apiKeys: ["cli-tools", "api-keys"] as const,
    mappings: (toolId: string | undefined) => ["cli-tools", "mappings", toolId] as const,
  },
  /** `/console/api/oauth/sessions/:id` — OAuth popup polling. */
  oauthLogin: {
    session: (sessionId: string | null | undefined) => ["oauth-login", sessionId] as const,
  },
  persona: {
    all: ["persona"] as const,
    monitor: ["persona", "monitor"] as const,
  },
  playground: {
    catalog: ["playground", "catalog"] as const,
    relaySecret: ["playground", "relay-secret"] as const,
  },
  /** `/console/api/coolify/*` — Coolify instance monitoring. */
  coolify: {
    connections: ["coolify", "connections"] as const,
    overview: (connectionId: string | undefined) => ["coolify", connectionId, "overview"] as const,
    projects: (connectionId: string | undefined) => ["coolify", connectionId, "projects"] as const,
    projectDetail: (connectionId: string | undefined, uuid: string | undefined) =>
      ["coolify", connectionId, "projects", uuid] as const,
    applications: (connectionId: string | undefined) => ["coolify", connectionId, "applications"] as const,
    applicationDetail: (connectionId: string | undefined, uuid: string | undefined) =>
      ["coolify", connectionId, "applications", uuid] as const,
    services: (connectionId: string | undefined) => ["coolify", connectionId, "services"] as const,
    servers: (connectionId: string | undefined) => ["coolify", connectionId, "servers"] as const,
    deployments: (connectionId: string | undefined) => ["coolify", connectionId, "deployments"] as const,
  },
} as const;

export type QueryKeys = typeof qk;
