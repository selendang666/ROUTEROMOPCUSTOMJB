# Oh My Omop — Router

Self-hosted AI proxy router with an authenticated dashboard. Routes OpenAI ↔ Anthropic
(and other compatible upstreams) through a single endpoint, with provider fallback,
credential encryption, per-key telemetry, and a full web console.

Bun · Elysia · TypeScript · PostgreSQL · SQLite telemetry · Redis (optional)

---

## Deploy on Railway

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new/template)

This repo ships a ready-to-use Railway template (`railway.toml` + `Dockerfile`).
The image builds the dashboard, compiles the router to a single Bun binary, and
builds the bundled `wireproxy` helper — no local toolchain needed.

### What the template creates

| Service | Purpose | Required |
|---|---|---|
| **App** (this repo) | Router + dashboard, port `$PORT` | yes |
| **Postgres** | Durable config authority (`DATABASE_URL`) | yes |
| **Volume** | Mounted at `/app/data`, persists SQLite telemetry | yes (auto) |
| Redis | Optional coordination / telemetry cache | no |

> The router **requires** PostgreSQL. Without `DATABASE_URL` it fails fast at boot.
> In the Railway template, reference the Postgres service:
> `DATABASE_URL = ${{Postgres.DATABASE_URL}}`

### Environment variables

**Required**

| Variable | Value / how to get it |
|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (Railway reference) |
| `APP_SECRET` | random, **≥ 32 chars**, non-placeholder. `openssl rand -hex 32` |
| `PROXY_API_KEY` | random key clients use to call the proxy. `openssl rand -hex 24` |
| `PUBLIC_ORIGIN` | `https://${{RAILWAY_PUBLIC_DOMAIN}}` |
| `TRUST_PROXY` | `true` — Railway terminates TLS in front of the container |
| `PORT` | `${{PORT}}` — injected by Railway, read from env at boot |

**Optional (sane defaults)**

| Variable | Default | Notes |
|---|---|---|
| `HOST` | `0.0.0.0` | bind address |
| `SQLITE_PATH` | `/app/data/telemetry.db` | set in Dockerfile; needs the volume |
| `REDIS_URL` | *(unset)* | falls back to in-memory coordination |
| `WIREPROXY_BIN` | `/app/bin/wireproxy` | bundled Linux binary |
| `WIREGUARD_CONFIG_DIR` | — | only if you use the WireGuard proxy pool |
| `APP_SECRET_PREV` | — | previous secret during rotation |
| `TELEMETRY_D1_URL` / `TELEMETRY_D1_TOKEN` | — | use Cloudflare D1 instead of SQLite |
| `OHMYOMOP_ROUTER_REQUEST_LOGS` | `1` | set `0` to disable request logs |

> Production guard rails (in `src/runtime/runtime.ts`): `APP_SECRET` must be ≥ 32
> characters and not contain `change-me` / `replace-with` / `password`;
> `PROXY_API_KEY` must be non-empty. The container will **not** start otherwise.

### First boot

There is **no** console-password environment variable. After the first deploy:

1. Open `https://<your-domain>/` — the setup screen asks you to create the first
   console account (email + password).
2. Log in to the dashboard.
3. Add upstream providers and issue proxy API keys.
4. Point your clients at `https://<your-domain>/v1` with `x-api-key: <PROXY_API_KEY>`
   (or `Authorization: Bearer …`).

### Health

- `GET /health` — human-readable status page
- `GET /health/ready` — readiness probe (used by Railway healthcheck)
- `GET /health/overhead`, `GET /metrics` — require an API key

---

## Local development

```bash
bun install
cd dashboard && bun install && cd ..
cp .env.example .env   # then fill APP_SECRET / PROXY_API_KEY / DATABASE_URL
bun run dev            # router on :12800
bun run dev:dashboard  # dashboard dev server
```

Full docker-compose stack (app + Postgres + optional Redis):

```bash
docker compose up --build
```

---

## Documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — request path, persistence, policy layers
- [`docs/OPERATIONS.md`](docs/OPERATIONS.md) — environment, limits, retention, deployment
- [`docs/PROVIDERS.md`](docs/PROVIDERS.md) — upstream provider quirks and presets
- [`docs/API.md`](docs/API.md) — proxy surfaces and endpoints

## License

MIT — see [LICENSE](LICENSE).
