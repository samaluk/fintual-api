FROM node:26.13.0-slim AS base

WORKDIR /app

COPY package.json ./

RUN npm install --global "$(node -p 'require("./package.json").packageManager')"

FROM base AS deps

COPY pnpm-lock.yaml pnpm-workspace.yaml ./

RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
	pnpm install --frozen-lockfile --prod

FROM base AS runtime

ENV NODE_ENV=production
ENV RUN_MODE=schedule

COPY --from=deps /app/node_modules ./node_modules

COPY . .

CMD ["pnpm", "schedule"]
