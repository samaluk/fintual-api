FROM node:24.14.0-slim

WORKDIR /app

COPY package.json pnpm-lock.yaml ./

RUN corepack enable \
	&& pnpm install --frozen-lockfile \
	&& pnpm exec playwright install --with-deps chromium chromium-headless-shell \
	&& apt-get update \
	&& apt-get install -y xauth \
	&& rm -rf /var/lib/apt/lists/*

COPY . .

RUN chmod +x ./bin/run-sync.sh ./bin/run-gmail-token.sh \
	&& pnpm run typecheck

ENV NODE_ENV=production

CMD ["./bin/run-sync.sh"]
