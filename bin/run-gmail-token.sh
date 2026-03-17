#!/bin/sh
set -eu

export GMAIL_OAUTH_BIND_HOST="${GMAIL_OAUTH_BIND_HOST:-0.0.0.0}"
export GMAIL_OAUTH_OPEN_BROWSER="${GMAIL_OAUTH_OPEN_BROWSER:-false}"

exec node dist/gmail-token.js
