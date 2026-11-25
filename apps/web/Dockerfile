# syntax=docker/dockerfile:1
# Web image: a Next.js standalone build, so the runtime holds only the traced files it needs.
# Node 20 is kept on purpose; see "Limitations" in the README.
ARG NODE_IMAGE=node:20.19-alpine

FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc tsconfig.base.json ./
COPY packages/sync-core/package.json packages/sync-core/
COPY packages/test-kit/package.json packages/test-kit/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci --workspace @fieldsync/sync-core --workspace @fieldsync/web --include-workspace-root --ignore-scripts
COPY packages/sync-core packages/sync-core
COPY apps/web apps/web
# NEXT_PUBLIC_* values are compiled into the client bundle, so the API URL is a build argument.
ARG NEXT_PUBLIC_API_URL=http://localhost:3001
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL} NEXT_OUTPUT=standalone NEXT_TELEMETRY_DISABLED=1
RUN npm run build:core && npm run build -w @fieldsync/web

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static apps/web/.next/static
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/" || exit 1
CMD ["node", "apps/web/server.js"]
