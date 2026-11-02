FROM node:26.13.0-slim AS base

ENV PNPM_HOME=/pnpm

COPY --from=ghcr.io/pnpm/pnpm:12.16.1 /opt/pnpm /opt/pnpm

RUN for bin in pnpm pn pnpx pnx; do ln -s "/opt/pnpm/$bin" "/usr/local/bin/$bin"; done

WORKDIR /app

FROM base AS deps

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
	pnpm install --store-dir=/pnpm/store --frozen-lockfile --prod

FROM base AS runtime

ENV NODE_ENV=production
ENV RUN_MODE=schedule

COPY --from=deps /app/node_modules ./node_modules

COPY . .

CMD ["pnpm", "schedule"]
