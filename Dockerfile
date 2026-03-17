FROM node:24-slim

WORKDIR /app

COPY package.json ./

RUN npm install \
	&& npx playwright install --with-deps chromium chromium-headless-shell \
	&& apt-get update \
	&& apt-get install -y xauth \
	&& rm -rf /var/lib/apt/lists/*

COPY . .

RUN chmod +x ./bin/run-sync.sh ./bin/run-gmail-token.sh \
	&& npm run build

ENV NODE_ENV=production

CMD ["./bin/run-sync.sh"]
