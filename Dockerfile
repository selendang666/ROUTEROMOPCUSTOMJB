# syntax=docker/dockerfile:1

# ─── Stage 1: Build dashboard + install deps ────────────────────────────────
FROM oven/bun:1.4.0-debian@sha256:994ab4c38ff6391322a2264dcf11860561a8621756270e11335e097eb774965a AS build
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY dashboard/package.json dashboard/bun.lock ./dashboard/
RUN cd dashboard && bun install --frozen-lockfile

COPY . .
RUN cd dashboard && bun run build
RUN bun build --compile --compile-autoload-dotenv --minify --bytecode --target bun --outfile /out/ohmyomop-router src/main.ts

FROM golang:1.26-bookworm AS wireproxy-build
WORKDIR /build
COPY vendor/wireproxy/go.mod vendor/wireproxy/go.sum ./
RUN go mod download
COPY vendor/wireproxy/ ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/wireproxy ./cmd/wireproxy

# ─── Stage 2: Runtime ───────────────────────────────────────────────────────
FROM oven/bun:1.4.0-debian@sha256:994ab4c38ff6391322a2264dcf11860561a8621756270e11335e097eb774965a AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=12800 \
    SQLITE_PATH=/app/data/telemetry.db

RUN apt-get update \
    && apt-get install --no-install-recommends -y \
      ca-certificates \
      adduser \
      gosu \
      wget \
    && rm -rf /var/lib/apt/lists/* \
    && addgroup --system ohmyomop-router \
    && adduser --system --ingroup ohmyomop-router ohmyomop-router \
    && mkdir -p /app/bin /app/data \
    && chown -R ohmyomop-router:ohmyomop-router /app

COPY --from=build --chown=ohmyomop-router:ohmyomop-router /out/ohmyomop-router /app/bin/ohmyomop-router
COPY --from=wireproxy-build --chown=ohmyomop-router:ohmyomop-router /out/wireproxy /app/bin/wireproxy
COPY --from=build --chown=ohmyomop-router:ohmyomop-router /app/dashboard/dist ./dashboard/dist
COPY --from=build --chown=ohmyomop-router:ohmyomop-router /app/drizzle/pg ./drizzle/pg
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 0755 /usr/local/bin/docker-entrypoint.sh

EXPOSE 12800

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT:-12800}/health/ready >/dev/null || exit 1

STOPSIGNAL SIGTERM

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["/app/bin/ohmyomop-router"]
