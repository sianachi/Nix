# syntax=docker/dockerfile:1
FROM node:22-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /repo

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/ packages/
COPY apps/web/ apps/web/
COPY apps/collab/package.json apps/collab/
COPY apps/media/package.json apps/media/
RUN pnpm install --frozen-lockfile

RUN pnpm --filter @nix/web build

FROM caddy:2-alpine AS web
COPY --from=build /repo/apps/web/dist /srv/nix/web
# The Caddyfile arrives from a ConfigMap at /etc/caddy/Caddyfile (deploy/k8s/Caddyfile),
# so proxy targets can change without a rebuild.
EXPOSE 8090
