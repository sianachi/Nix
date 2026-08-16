# syntax=docker/dockerfile:1
# One file, two targets. Build with --target collab or --target media.
FROM node:22-slim AS deps
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /repo

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/ packages/
COPY apps/collab/ apps/collab/
COPY apps/media/ apps/media/
COPY apps/web/package.json apps/web/

# Installs the workspace and runs the root "prepare", which builds every package
# collab and media import. Skipping it leaves them importing empty dist/ folders.
RUN pnpm install --frozen-lockfile

FROM node:22-slim AS collab
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NODE_ENV=production
RUN corepack enable
WORKDIR /repo
COPY --from=deps /repo /repo
EXPOSE 8100
USER node
CMD ["pnpm", "--filter", "@nix/collab", "start"]

FROM node:22-slim AS media
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NODE_ENV=production
RUN corepack enable
WORKDIR /repo
COPY --from=deps /repo /repo
EXPOSE 8200
USER node
CMD ["pnpm", "--filter", "@nix/media", "start"]
