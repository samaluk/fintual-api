FROM node:24.15.0-slim AS deps

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
	corepack enable \
	&& pnpm install --frozen-lockfile --prod

FROM node:24.15.0-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules

COPY . .

RUN chmod +x ./bin/run-sync.sh

CMD ["./bin/run-sync.sh"]
