#!/usr/bin/env sh
# Record Fintual sign-in and GraphQL traffic to tmp/fintual-capture.har using agent-browser.
# Requires agent-browser >= 0.22 (network har subcommands).
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT_DIR"

HAR_PATH="${FINTUAL_HAR_PATH:-$ROOT_DIR/tmp/fintual-capture.har}"
SESSION="${AGENT_BROWSER_SESSION:-fintual-har-capture}"

if ! command -v agent-browser >/dev/null 2>&1; then
	echo "agent-browser not found. Install: npm i -g agent-browser@latest" >&2
	exit 1
fi

# Load only FINTUAL_* from .env via dotenv (single-quoted values so $ in passwords is not expanded).
if [ -f .env ]; then
	# shellcheck disable=SC1090
	eval "$(node "$ROOT_DIR/bin/load-fintual-env-for-capture.mjs")"
fi

mkdir -p "$(dirname "$HAR_PATH")"

export AGENT_BROWSER_HEADED="${AGENT_BROWSER_HEADED:-1}"

agent-browser --session "$SESSION" close 2>/dev/null || true
agent-browser --session "$SESSION" network har start
agent-browser --session "$SESSION" open https://fintual.cl/f/sign-in/
agent-browser --session "$SESSION" wait --load networkidle

if [ -n "${FINTUAL_USER_EMAIL:-}" ] && [ -n "${FINTUAL_USER_PASSWORD:-}" ]; then
	agent-browser --session "$SESSION" find label "Correo electrónico" fill "$FINTUAL_USER_EMAIL"
	agent-browser --session "$SESSION" find label "Contraseña" fill "$FINTUAL_USER_PASSWORD"
	agent-browser --session "$SESSION" wait 2000
	agent-browser --session "$SESSION" find role button click --name "Entrar"
	agent-browser --session "$SESSION" wait --load networkidle
else
	echo "FINTUAL_USER_EMAIL / FINTUAL_USER_PASSWORD not set; sign in manually in the browser window." >&2
fi

echo "If 2FA is required, complete it in the browser, then press Enter." >&2
printf "Press Enter when ready to POST /gql/ (GoalInvestedBalanceGraphDataPoints): " >&2
read -r _

GOAL_ID="${FINTUAL_GOAL_ID:-1}"
export FINTUAL_GOAL_ID="$GOAL_ID"
node "$ROOT_DIR/bin/fintual-gql-eval-fragment.mjs" | agent-browser --session "$SESSION" eval --stdin

agent-browser --session "$SESSION" network har stop "$HAR_PATH"
echo "HAR saved to $HAR_PATH"
