#!/usr/bin/env node
// Fallow gate orchestrator: the authoritative local equivalent of the CI gate.
//
// Exit codes follow Fallow's contract:
//   0 = clean/pass
//   1 = successful analysis with findings (gate failed)
//   2 = actual error (config, coverage missing, infra)
//
// Gates:
//   audit         changed-code gate (fallow audit, gate new-only, type-aware)
//   dead-code     project-wide identity baseline for unused-code findings
//   dupes         project-wide identity baseline for clone groups
//   health        project-wide identity baseline for complexity findings
//   regression    count ratchet against the committed regression baseline
//   baseline      baseline freshness (committed baselines must match a clean
//                 regeneration; a one-way ratchet)
//
// Usage: node bin/fallow-ci.mjs [gate ...]   (default: all gates)

import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"

const COVERAGE = "coverage/coverage-final.json"
const DIR = "fallow-baselines"
// Pin the changed-code gate to the same base CI uses. Without this, on an
// already-pushed feature branch fallow would scope to the branch's own
// upstream and silently miss findings introduced by earlier commits.
const AUDIT_BASE = process.env.FALLOW_AUDIT_BASE ?? "origin/main"

const hasCoverage = () => existsSync(COVERAGE)

function run(args, options = {}) {
  return spawnSync("pnpm", ["exec", "fallow", ...args], {
    encoding: "utf8",
    env: options.env ?? undefined,
  })
}

function parseJson(result) {
  try {
    return JSON.parse(result.stdout)
  } catch {
    return null
  }
}

function detailFor(result, fallback) {
  return (result.stdout || result.stderr || "").trim().slice(0, 300) || fallback
}

// Map a nullable finding count to a gate verdict: an analyzer error (exit 2)
// is never masked even when the run still emitted a parseable report, and any
// positive count fails the gate (exit 1).
function countVerdict(count, result, noun) {
  if (result.status === 0 || result.status === 1) {
    if (count !== null) {
      return {
        status: count > 0 ? 1 : 0,
        detail: `${count} new ${noun} vs baseline`,
      }
    }
  }
  return { status: 2, detail: detailFor(result, `exit ${result.status}`) }
}

function auditVerdict(result) {
  const json = parseJson(result)
  const detail = []
  if (json?.verdict) detail.push(`verdict ${json.verdict}`)
  const attr = json?.attribution
  if (attr) {
    detail.push(
      `introduced: dead ${attr.dead_code_introduced} · complexity ${attr.complexity_introduced} · dupes ${attr.duplication_introduced}`,
    )
  }
  return {
    status: result.status ?? 2,
    detail: detail.join(", ") || detailFor(result, `exit ${result.status}`),
  }
}

function regressionVerdict(result) {
  if (result.status === 2) {
    return { status: 2, detail: detailFor(result, `exit ${result.status}`) }
  }
  const status = parseJson(result)?.check?.regression?.status ?? null
  return {
    status: status === "exceeded" ? 1 : result.status ?? 0,
    detail: status ? `status ${status}` : detailFor(result, `exit ${result.status}`),
  }
}

// Each gate declares how to run and how to read the verdict from JSON.
const GATES = {
  audit: {
    needsCoverage: true,
    run: () =>
      run(["audit", "--base", AUDIT_BASE, "--coverage", COVERAGE, "--format", "json", "--quiet"]),
    verdict: auditVerdict,
  },
  "dead-code": {
    needsCoverage: true,
    run: () =>
      run(["--baseline", `${DIR}/dead-code.json`, "--coverage", COVERAGE, "--format", "json", "--quiet"]),
    verdict: (result) => countVerdict(parseJson(result)?.check?.total_issues ?? null, result, "finding(s)"),
  },
  dupes: {
    needsCoverage: false,
    run: () => run(["dupes", "--baseline", `${DIR}/dupes.json`, "--format", "json", "--quiet"]),
    verdict: (result) => countVerdict(parseJson(result)?.clone_groups?.length ?? null, result, "clone group(s)"),
  },
  health: {
    needsCoverage: true,
    run: () =>
      run(["health", "--coverage", COVERAGE, "--baseline", `${DIR}/health.json`, "--baseline-mode", "identity", "--format", "json", "--quiet"]),
    verdict: (result) => countVerdict(parseJson(result)?.findings?.length ?? null, result, "finding(s)"),
  },
  regression: {
    needsCoverage: true,
    run: () =>
      run(["--fail-on-regression", "--regression-baseline", `${DIR}/regression.json`, "--coverage", COVERAGE, "--format", "json", "--quiet"]),
    verdict: regressionVerdict,
  },
  baseline: {
    needsCoverage: false,
    run: () => spawnSync("node", ["bin/fallow-baseline.mjs", "check"], { encoding: "utf8" }),
    verdict: (result) => ({
      status: result.status ?? 2,
      detail: (result.stdout || result.stderr || "").trim().slice(0, 300),
    }),
  },
}

const selected = process.argv.slice(2)
const names = selected.length > 0 ? selected : Object.keys(GATES)

const failures = []
let sawError = false

for (const name of names) {
  const gate = GATES[name]
  if (!gate) {
    console.error(`unknown gate: ${name}`)
    sawError = true
    continue
  }
  if (gate.needsCoverage && !hasCoverage()) {
    console.error(
      `[FAIL] ${name} — error: ${COVERAGE} is missing; run \`pnpm test:coverage\` first so health/CRAP uses real coverage evidence`,
    )
    sawError = true
    continue
  }
  const result = gate.run()
  const { status, detail } = gate.verdict(result)
  if (status === 2 || status === 1) {
    // Show the underlying analyzer output only when a gate fails.
    if (result.stdout) process.stdout.write(result.stdout)
    if (result.stderr) process.stderr.write(result.stderr)
  }
  if (status === 2) {
    sawError = true
    console.error(`[FAIL] ${name} — error: ${detail}`)
  } else {
    const failed = status === 1
    if (failed) failures.push(name)
    console.log(`[${failed ? "FAIL" : "ok"}] ${name} — ${detail}`)
  }
}

console.log("")
if (sawError) {
  console.error("fallow:ci failed with an analyzer/config error (exit 2). See messages above.")
  process.exitCode = 2
} else if (failures.length > 0) {
  console.error(`fallow:ci failed gates: ${failures.join(", ")}`)
  process.exitCode = 1
} else {
  console.log("fallow:ci passed: all gates clean.")
  process.exitCode = 0
}
