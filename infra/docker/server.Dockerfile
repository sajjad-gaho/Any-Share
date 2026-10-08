# syntax=docker/dockerfile:1.7
#
# Production image for apps/api or apps/signaling (one Dockerfile, two images):
#
#   docker build -f infra/docker/server.Dockerfile --build-arg SERVICE=api       -t kestrel-api .
#   docker build -f infra/docker/server.Dockerfile --build-arg SERVICE=signaling -t kestrel-signaling .
#
# The build context is the repository root; .dockerignore keeps every .env file,
# the desktop app and the native helper out of it. No secret is baked in:
# configuration arrives as environment variables at run time.

ARG NODE_VERSION=24

# ---------------------------------------------------------------- build stage
FROM node:${NODE_VERSION}-bookworm-slim AS build
ARG SERVICE
RUN test "$SERVICE" = "api" || test "$SERVICE" = "signaling" \
  || (echo "SERVICE must be api or signaling" && exit 1)

ENV CI=true PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@10.34.6 --activate

WORKDIR /repo
# Dependency layer: only changes when the lockfile does.
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm fetch

COPY . .
# The service, its workspace dependencies and the root build tooling (esbuild).
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --offline --frozen-lockfile \
      --filter "@remote-desktop/${SERVICE}..." --filter "remote-desktop"
RUN pnpm --filter "@remote-desktop/${SERVICE}" build

# Standalone production folder from the shared lockfile (exact, reproducible
# versions): package.json, dist/ and production node_modules only.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter "@remote-desktop/${SERVICE}" --config.inject-workspace-packages=true \
      deploy --prod --offline /out \
 && test -f /out/dist/main.js \
 && rm -rf /out/src /out/tsconfig.json /out/vitest.config.ts /out/README.md \
 && mkdir -p /out/certs && cp supabase/certs/prod-ca-2021.crt /out/certs/

# -------------------------------------------------------------- runtime stage
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ARG SERVICE
ARG PORT
ENV NODE_ENV=production \
    APP_ENV=production \
    SERVICE=${SERVICE} \
    HEALTH_PORT=${PORT} \
    DATABASE_SSL_CA_FILE=/app/certs/prod-ca-2021.crt

WORKDIR /app
COPY --from=build --chown=root:root /out ./
# Read-only for the service user; it writes nothing to disk (logs go to stdout).
RUN chmod -R a-w /app

USER node
EXPOSE ${PORT}

# Liveness only (no dependencies, no data). Readiness: GET /health/ready.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + process.env.HEALTH_PORT + '/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

CMD ["node", "--enable-source-maps", "dist/main.js"]
