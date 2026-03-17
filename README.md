# fintual-api

`fintual-api` is a one-shot worker that logs into Fintual, fetches investment performance data, and imports the resulting variation transactions into Actual Budget.

The repo intentionally supports only two flows:

- `bun once` runs the full sync once
- `bun gmail:token` bootstraps the Gmail OAuth refresh token used for unattended 2FA

## Requirements

- Bun or Node.js 20+
- Playwright browser dependencies
- Fintual credentials
- Actual Budget server credentials
- Gmail OAuth credentials for unattended 2FA

## Setup

1. Install dependencies:

```bash
bun install
```

2. Create a local env file:

```bash
cp .env.example .env
```

3. Fill in your Actual, Fintual, and Gmail values.

## Gmail OAuth Bootstrap

Run this locally once to generate `GMAIL_REFRESH_TOKEN`:

```bash
bun gmail:token
```

If `.env` exists, the command updates it in place. If `.env` does not exist, the command prints only the generated `GMAIL_REFRESH_TOKEN` so you can store it manually in Komodo or another secret manager.

## Run Once

Build the project and run the sync once:

```bash
bun run build
bun once
```

The worker will:

- log in to Fintual with Playwright
- retrieve the Gmail 2FA code when needed
- write the scraped data to `tmp/fintual-data/balance-2.json`
- import variation transactions into Actual Budget

## Docker Image

The published container image is designed as a one-shot worker. Its default command runs the sync once:

```bash
docker run --rm --env-file .env ghcr.io/samaluk/fintual-api:latest
```

Mount `./tmp` if you want to inspect the generated files locally:

```bash
docker run --rm --env-file .env -v "$(pwd)/tmp:/app/tmp" ghcr.io/samaluk/fintual-api:latest
```

## Local Compose Workflow

The local compose file keeps the worker container idle so you can run the sync manually with the exact same Docker environment each time:

```bash
docker compose --env-file .compose.env up -d --build
docker exec -it fintual-api-local ./bin/run-sync.sh
```

The compose stack also starts `ofelia`, so you can test the scheduled `job-exec` path and inspect scheduler logs:

```bash
docker logs -f fintual-api-ofelia
```

Set `OFELIA_SYNC_SCHEDULE` in `.compose.env` if you want a faster local test cadence, for example:

```dotenv
OFELIA_SYNC_SCHEDULE=@every 5m
```

You can also generate the Gmail refresh token inside the running Docker worker:

```bash
docker exec -it fintual-api-local ./bin/run-gmail-token.sh
```

That command listens on container port `3000`, which is published to the host by compose. If the worker has a mounted `.env`, it updates that file. Otherwise it prints only the generated refresh token so you can copy it into your secret manager.

The Docker wrapper disables browser auto-open by default, so seeing only the printed URL is expected.

Useful commands while debugging:

```bash
docker logs -f fintual-api-local
docker logs -f fintual-api-ofelia
docker exec -it fintual-api-local sh
docker exec -it fintual-api-local ./bin/run-sync.sh
docker exec -it fintual-api-local ./bin/run-gmail-token.sh
docker compose --env-file .compose.env down
```

## GitHub Actions Publishing

This repo publishes `ghcr.io/samaluk/fintual-api` in two channels:

- pushes to `main` publish a rolling `nightly` image plus `sha-<commit>`
- GitHub Releases publish stable release images

Published tags:

- `nightly` from `main`
- `sha-<commit>`
- `latest` from GitHub Releases
- the GitHub Release tag itself, such as `v1.0.0`

## Homelab Deployment

The intended production model is:

- GitHub Actions publishes the worker image to GHCR
- the homelab compose stack pulls the image
- a long-lived idle worker keeps secrets in its runtime environment
- Ofelia schedules `job-exec` runs inside that worker
- Komodo deploys compose changes from the homelab repo

Recommended Ofelia schedule for Santiago, Chile weekdays at 21:00:

- cron: `0 21 * * 1-5`
- timezone: `America/Santiago`

Use an idle `fintual-api` worker plus an `ofelia` service that executes `./bin/run-sync.sh` on schedule.

For homelab Gmail bootstrap, keep the callback bound to `127.0.0.1:3000` on the homelab host and create an SSH tunnel from your laptop:

```bash
ssh -L 3000:127.0.0.1:3000 <homelab-host>
```

Then run `docker exec -it fintual-api ./bin/run-gmail-token.sh` on the homelab machine, open the printed Google OAuth URL in your local browser, and store the printed token as `GMAIL_REFRESH_TOKEN` in Komodo or Infisical.
