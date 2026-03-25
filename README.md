# fintual-api

`fintual-api` is a one-shot worker that logs into Fintual, fetches investment performance data, and imports the resulting variation transactions into Actual Budget.

The repo intentionally supports only two flows:

- `pnpm once` runs the full sync once
- unattended 2FA retrieval via Gmail IMAP + app password

## Requirements

- Node.js 24+
- pnpm
- Fintual credentials
- Actual Budget server credentials
- Gmail app password for unattended 2FA

## Setup

1. Install dependencies:

```bash
pnpm install
```

1. Create a local env file:

```bash
cp .env.example .env
```

1. Fill in your Actual, Fintual, and Gmail values.

## Gmail IMAP Setup

Enable 2-Step Verification in Google Account settings, then create a Gmail app password for the mailbox used to receive Fintual 2FA emails.

### Simplified Gmail app password generation

1. Open the 2-Step Verification page (you only need to do this once): [2-Step Verification](https://myaccount.google.com/security)
2. Open App Passwords directly: [App Passwords](https://myaccount.google.com/apppasswords)
3. Create an app password for any label (for example: `fintual-api`), then copy the generated 16-character password.
4. Paste it into `.env` as `GMAIL_APP_PASSWORD`.

If you prefer a quick copy/paste terminal flow:

```bash
read -s "GMAIL_APP_PASSWORD?Paste Gmail app password: "; echo
cat >> .env <<EOF
GMAIL_USER_EMAIL=your@gmail.com
GMAIL_APP_PASSWORD=$GMAIL_APP_PASSWORD
GMAIL_IMAP_HOST=imap.gmail.com
GMAIL_IMAP_PORT=993
EOF
unset GMAIL_APP_PASSWORD
```

Set these values in `.env` (or your runtime secret manager):

- `GMAIL_USER_EMAIL`
- `GMAIL_APP_PASSWORD`
- `GMAIL_IMAP_HOST` (default: `imap.gmail.com`)
- `GMAIL_IMAP_PORT` (default: `993`)

`fintual-api` polls IMAP over TLS and extracts the 6-digit code from matching emails.

## gcloud Secret Manager (CLI-only)

Use `gcloud` CLI to store and retrieve the Gmail app password without committing it:

```bash
gcloud secrets create fintual-gmail-app-password --replication-policy=automatic
printf '%s' "$GMAIL_APP_PASSWORD" | gcloud secrets versions add fintual-gmail-app-password --data-file=-
gcloud secrets versions access latest --secret=fintual-gmail-app-password
```

Example to materialize a local `.env` value from Secret Manager:

```bash
echo "GMAIL_APP_PASSWORD=$(gcloud secrets versions access latest --secret=fintual-gmail-app-password)" >> .env
```

## Run Once

Optionally type-check the project, then run the sync directly from the TypeScript source:

```bash
pnpm typecheck
pnpm once
```

The worker will:

- log in to Fintual over HTTP (`initiate_login` → Gmail IMAP 2FA when required → `finalize_login_web`) and fetch GraphQL performance data
- write the result to `tmp/fintual-data/balance-2.json`
- import variation transactions into Actual Budget

### Reverse-engineering Fintual HTTP (agent-browser)

To capture login and GraphQL traffic for analysis (HAR), use **agent-browser ≥ 0.22** and run:

```bash
pnpm capture:har
```

Details and observed endpoints are in [`docs/fintual-http-capture.md`](docs/fintual-http-capture.md). Output goes to `tmp/fintual-capture.har` (gitignored).

## Docker Image

The published container image is designed as a one-shot worker. Its default command runs the sync once:

```bash
docker run --rm --env-file .env docker.io/samaluk/fintual-api:latest
```

Mount `./tmp` if you want to inspect the generated files locally:

```bash
docker run --rm --env-file .env -v "$(pwd)/tmp:/app/tmp" docker.io/samaluk/fintual-api:latest
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

If you keep runtime secrets in Secret Manager, fetch `GMAIL_APP_PASSWORD` at deploy time and inject it into the homelab runtime env instead of storing it in compose files.

Useful commands while debugging:

```bash
docker logs -f fintual-api-local
docker logs -f fintual-api-ofelia
docker exec -it fintual-api-local sh
docker exec -it fintual-api-local ./bin/run-sync.sh
docker compose --env-file .compose.env down
```

## GitHub Actions Publishing

This repo publishes `docker.io/samaluk/fintual-api` from GitHub Releases.

Repository secrets required for publishing:

- `DOCKERHUB_USERNAME`
- `DOCKERHUB_TOKEN`

Published tags:

- `sha-<commit>`
- `latest` from GitHub Releases
- the GitHub Release tag itself, such as `v1.0.0`

## Homelab Deployment

The intended production model is:

- GitHub Actions publishes the worker image to Docker Hub
- the homelab compose stack pulls the image
- a long-lived idle worker keeps secrets in its runtime environment
- Ofelia schedules `job-exec` runs inside that worker
- Komodo deploys compose changes from the homelab repo

Recommended Ofelia schedule for Santiago, Chile weekdays at 21:00:

- cron: `0 21 * * 1-5`
- timezone: `America/Santiago`

Use an idle `fintual-api` worker plus an `ofelia` service that executes `./bin/run-sync.sh` on schedule.

For homelab deployments, store `GMAIL_APP_PASSWORD` in your secret manager (for example, GCP Secret Manager) and inject it into the worker environment at runtime.
