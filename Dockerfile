# syntax=docker/dockerfile:1.7
ARG PLAYWRIGHT_VERSION=1.62.0
FROM node:22-alpine AS deps
WORKDIR /workspace
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/mcp/package.json apps/mcp/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/assurance/package.json packages/assurance/package.json
COPY packages/browser-runtime/package.json packages/browser-runtime/package.json
COPY packages/chronicle/package.json packages/chronicle/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/executor/package.json packages/executor/package.json
COPY packages/observability/package.json packages/observability/package.json
COPY packages/policy/package.json packages/policy/package.json
COPY packages/praxis/package.json packages/praxis/package.json
COPY packages/veil/package.json packages/veil/package.json
RUN --mount=type=cache,id=scry-pnpm,target=/pnpm/store pnpm install --frozen-lockfile --store-dir /pnpm/store

FROM deps AS prod-deps
RUN --mount=type=cache,id=scry-pnpm,target=/pnpm/store \
    rm -rf node_modules apps/*/node_modules packages/*/node_modules \
    && pnpm install --prod --offline --frozen-lockfile --store-dir /pnpm/store

FROM deps AS build
COPY apps/web apps/web
RUN pnpm --filter @scry/web build

FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble AS runner
ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /workspace

COPY --from=prod-deps /workspace/package.json /workspace/pnpm-workspace.yaml /workspace/tsconfig.base.json ./
COPY --from=prod-deps /workspace/node_modules ./node_modules
COPY --from=prod-deps /workspace/apps ./apps
COPY --from=prod-deps /workspace/packages ./packages
COPY apps/api apps/api
COPY apps/mcp apps/mcp
COPY packages/browser-runtime packages/browser-runtime
COPY packages/chronicle packages/chronicle
COPY packages/contracts packages/contracts
COPY packages/executor packages/executor
COPY packages/observability packages/observability
COPY packages/policy packages/policy
COPY packages/praxis packages/praxis
COPY packages/veil packages/veil
COPY scripts/schema-fingerprint.mjs scripts/verify-deployment-preflight.mjs ./scripts/
COPY --from=build /workspace/apps/web/dist ./apps/web/dist
COPY apps/web/scripts ./apps/web/scripts

CMD ["apps/api/node_modules/.bin/tsx", "--tsconfig", "apps/api/tsconfig.json", "apps/api/src/browser-v2-main.ts"]
