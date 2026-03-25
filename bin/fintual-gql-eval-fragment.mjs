/**
 * Writes one line of JavaScript suitable for `agent-browser eval --stdin`
 * (async IIFE that POSTs GoalInvestedBalanceGraphDataPoints to /gql/).
 */
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const goalId = process.env.FINTUAL_GOAL_ID || "1"

const queryPath = resolve(import.meta.dirname, "fintual-goal-performance.graphql")
const query = readFileSync(queryPath, "utf-8").trim()

const script = `(async () => {
  const query = ${JSON.stringify(query)};
  const goalId = ${JSON.stringify(goalId)};
  const r = await fetch("https://fintual.cl/gql/", {
    credentials: "include",
    headers: { Accept: "*/*", "content-type": "application/json" },
    method: "POST",
    body: JSON.stringify({
      operationName: "GoalInvestedBalanceGraphDataPoints",
      variables: { goalId, timeIntervalCode: "last_month" },
      query,
    }),
  });
  const t = await r.text();
  return JSON.stringify({ status: r.status, ok: r.ok, bodyPreview: t.slice(0, 200) });
})()`
process.stdout.write(script)
