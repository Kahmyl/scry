# syntax=docker/dockerfile:1.7
ARG PLAYWRIGHT_VERSION=1.62.0
FROM node:22-alpine AS deps
WORKDIR /workspace
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/mcp/package.json apps/mcp/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/artifact/package.json packages/artifact/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/executor/package.json packages/executor/package.json
COPY packages/policy/package.json packages/policy/package.json
RUN --mount=type=cache,id=scry-pnpm,target=/pnpm/store pnpm install --frozen-lockfile

FROM deps AS build
COPY apps/web apps/web
RUN pnpm --filter @scry/web build

FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble AS runner
ENV NODE_ENV=production
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /workspace
RUN corepack enable

COPY --from=deps /workspace/package.json /workspace/pnpm-workspace.yaml /workspace/tsconfig.base.json ./
COPY --from=deps /workspace/node_modules ./node_modules
COPY --from=deps /workspace/apps ./apps
COPY --from=deps /workspace/packages ./packages
COPY apps/api apps/api
COPY apps/mcp apps/mcp
COPY packages packages
COPY --from=build /workspace/apps/web/dist ./apps/web/dist
COPY apps/web/scripts ./apps/web/scripts

CMD ["pnpm", "--filter", "@scry/api", "start"]
