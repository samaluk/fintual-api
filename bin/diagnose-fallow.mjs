import { spawnSync } from "node:child_process"

const run = spawnSync(
  "pnpm",
  ["exec", "fallow", "dead-code", "--format", "json", "--quiet"],
  { encoding: "utf8" },
)

if (run.stderr.length > 0) {
  process.stderr.write(run.stderr)
}

let report
try {
  report = JSON.parse(run.stdout)
} catch {
  process.stderr.write("Fallow did not return a JSON report.\n")
  if (run.stdout.length > 0) process.stderr.write(run.stdout)
  process.exit(run.status ?? 1)
}

const typeAware = report._meta?.type_aware
if (typeAware === undefined) {
  console.error("Fallow did not include type-aware analysis metadata.")
  process.exit(run.status ?? 1)
}

const { identity, queries = [], candidate_decisions: decisions = [] } = typeAware
const decisionsByQuery = new Map(decisions.map((decision) => [decision.query_id, decision]))
const incomplete = queries.filter((query) => query.status !== "complete")

console.log(`Type-aware analysis: ${identity.completeness}`)
console.log(`Backend: ${identity.backend_family}`)
console.log(`Project hash: ${identity.project_config_hash}`)
console.log(`Queries: ${queries.length - incomplete.length} complete, ${incomplete.length} incomplete`)

for (const query of incomplete) {
  const decision = decisionsByQuery.get(query.query_id)
  const subject = decision?.subject
  const location = subject === undefined
    ? "unknown subject"
    : `${subject.path}:${subject.line}:${subject.col} ${subject.owner === undefined ? "" : `${subject.owner}.`}${subject.local_name}`

  console.log("")
  console.log(`#${query.query_id} ${query.capability}/${query.assertion}: ${query.status}`)
  console.log(`  subject: ${location}`)
  console.log(`  gap: ${query.reason_code ?? decision?.reason_code ?? "unspecified"}`)
  console.log(`  evidence: ${query.total_evidence_count}${query.truncated ? " (truncated)" : ""}`)
  for (const omission of query.omissions ?? decision?.omissions ?? []) {
    console.log(`  omitted: ${omission.reason_code} (${omission.count})`)
  }
  if (decision?.explanation !== undefined) console.log(`  explanation: ${decision.explanation}`)
}

if (identity.completeness !== "complete" || incomplete.length > 0) {
  process.exitCode = 2
} else if (run.status !== 0 && run.status !== 1) {
  process.exitCode = run.status ?? 1
}
