# syntax=docker/dockerfile:1
# Server image; also runs the migrations (see the migrate service in docker-compose.yml).
# Node 20 is kept on purpose; see "Limitations" in the README.
ARG NODE_IMAGE=node:20.19-alpine

# Workspace manifests only, so dependency layers are cached until a manifest or the lockfile changes.
FROM ${NODE_IMAGE} AS manifests
WORKDIR /app
COPY package.json package-lock.json .npmrc tsconfig.base.json ./
COPY packages/sync-core/package.json packages/sync-core/
COPY packages/test-kit/package.json packages/test-kit/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/

FROM manifests AS build
RUN npm ci --workspace @fieldsync/sync-core --workspace @fieldsync/server --include-workspace-root --ignore-scripts
COPY packages/sync-core packages/sync-core
COPY apps/server apps/server
RUN npm run build:core && npm run build -w @fieldsync/server

FROM manifests AS prod-deps
RUN npm ci --omit=dev --workspace @fieldsync/sync-core --workspace @fieldsync/server --include-workspace-root --ignore-scripts

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production PORT=3001
WORKDIR /app
COPY --from=prod-deps /app ./
COPY --from=build /app/packages/sync-core/dist packages/sync-core/dist
COPY --from=build /app/apps/server/dist apps/server/dist
USER node
EXPOSE 3001
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/health" || exit 1
CMD ["node", "apps/server/dist/main.js"]
