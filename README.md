# fintual-api

`fintual-api` is a worker that logs into Fintual, fetches investment performance data, and imports the resulting variation transactions into Actual Budget. In its default mode it runs the sync on a cron schedule from inside the container process; a one-shot mode remains for manual diagnostics.

The repo intentionally supports only these flows:

- `pnpm schedule` runs the sync on the configured cron schedule when `RUN_MODE=schedule` is set (the container default)
- `pnpm once` runs the full sync once
- unattended 2FA retrieval via Gmail IMAP + app password

## Requirements

- Node.js 24+
- pnpm
- [hk](https://hk.jdx.dev/) 1.54+
- Fintual credentials
- Actual Budget server credentials
- Gmail app password for unattended 2FA

## Setup

1. Install dependencies:

```bash
pnpm install
```

1. Enable the repository's Git hooks. With Git 2.54+, the recommended one-time setup is:

```bash
hk install --global
```

   For an installation scoped to this clone instead, run `hk install`.

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
- fold the data into a Performance Snapshot, save it to `tmp/fintual-data/balance-2.json` for inspection, and pass it to the Actual sync step
- import variation transactions into Actual Budget

### Reverse-engineering Fintual HTTP (agent-browser)

To capture login and GraphQL traffic for analysis (HAR), use **agent-browser ≥ 0.22** and run:

```bash
pnpm capture:har
```

Details and observed endpoints are in [`docs/fintual-http-capture.md`](docs/fintual-http-capture.md). Output goes to `tmp/fintual-capture.har` (gitignored).

## Quality ratchet

Fallow 3.16 runs as a strict quality ratchet: changed-code audit, project-wide
identity baselines, regression counts, and baseline freshness — all enforced
locally, in git hooks, and in CI. See [`docs/fallow.md`](docs/fallow.md).

## Git hooks

[`hk`](https://hk.jdx.dev/) keeps local commits and pushes aligned with CI:

- `commit-msg` requires commit subjects to follow the [Conventional Commits](https://www.conventionalcommits.org/) format.
- `pre-commit` checks staged TypeScript with Oxfmt and Oxlint in parallel plus a fast Fallow audit of the staged diff. Safe fixes are applied and re-staged while unstaged changes are temporarily stashed.
- `pre-push` checks the files being pushed with Oxfmt and Oxlint while running the full TypeScript, coverage, test, and Fallow ratchet gates in parallel.

Run the hooks explicitly when needed:

```bash
hk run commit-msg .git/COMMIT_EDITMSG
hk run pre-commit
hk run pre-push
hk check --all
```

## Docker Image

> **Breaking change in the v3 major:** the image default command changed from
> a one-shot sync (exit after running once) to a long-lived scheduler process
> (run until interrupted). The previous invocation contract is not preserved
> and there is no retro-compatibility shim. See [Release guidance](#release-guidance).

The published container image runs the in-process cron scheduler by default. The
worker runs the synchronization at the configured schedule:

```bash
docker run --rm --env-file .env docker.io/samaluk/fintual-api:latest
```

Set `RUN_MODE=once` for a one-shot diagnostic run:

```bash
docker run --rm --env-file .env -e RUN_MODE=once docker.io/samaluk/fintual-api:latest
```

The schedule comes from environment configuration:

- `SYNC_CRON` defaults to `0 0 22 * * 1-5`
- `SYNC_TIMEZONE` defaults to `America/Santiago`
- `SYNC_NO_OVERLAP=true` skips a tick while a previous run is still in progress

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
- a long-lived worker runs the in-process scheduler and keeps secrets in its
  runtime environment
- Komodo deploys compose changes from the homelab repo

The scheduler mode is the container default. Configure the sync time with
`SYNC_CRON` and `SYNC_TIMEZONE` (for example, `0 0 22 * * 1-5` in
`America/Santiago`), and keep `RUN_MODE=once` available for manual
`docker exec` diagnostics.

The scheduler stops cleanly when the process is interrupted, including SIGTERM,
and each in-flight run's scoped resources are closed. Configure the container
restart policy (for example, `restart: unless-stopped`) so the worker comes back
after a host restart.

For homelab deployments, store `GMAIL_APP_PASSWORD` in your secret manager (for example, GCP Secret Manager) and inject it into the worker environment at runtime.

## Release guidance

Starting with the v3 major, the image default command runs the in-process
scheduler instead of a one-shot sync. This is a breaking change to the
container process contract:

- The default command (`bin/run-schedule.sh`) no longer exits after one sync.
  It runs the synchronization on the configured `SYNC_CRON` schedule until the
  process is interrupted (for example, SIGTERM).
- The previous invocation contract is not preserved: there is no
  retro-compatibility shim, and images published under the v3 major and later
  do not accept the old invocation.
- One-shot invocations remain available explicitly via `RUN_MODE=once` or
  `bin/run-sync.sh`, for manual `docker exec` diagnostics and CI-style runs.

Publish the breaking change under a new major version tag (for example, `v3.0.0`);
do not publish it under an existing v2 tag, because `latest` follows GitHub
Releases and old tags must keep the previous behavior.
