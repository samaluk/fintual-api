FROM node:24.14.0-slim AS deps

WORKDIR /app
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY package.json pnpm-lock.yaml ./

RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
	corepack enable \
	&& pnpm install --frozen-lockfile --prod \
	&& pnpm exec playwright install --with-deps chromium chromium-headless-shell \
	&& apt-get update \
	&& apt-get install -y --no-install-recommends xauth \
	&& rm -rf /var/lib/apt/lists/*

FROM node:24.14.0-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /ms-playwright /ms-playwright

COPY . .

RUN chmod +x ./bin/run-sync.sh ./bin/run-gmail-token.sh

CMD ["./bin/run-sync.sh"]
