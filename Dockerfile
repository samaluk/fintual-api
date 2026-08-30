FROM node:24.20.0-slim AS deps

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
	corepack enable \
	&& pnpm install --frozen-lockfile --prod

FROM node:24.20.0-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production
ENV RUN_MODE=schedule

RUN corepack enable

COPY --from=deps /app/node_modules ./node_modules

COPY . .

CMD ["pnpm", "schedule"]
