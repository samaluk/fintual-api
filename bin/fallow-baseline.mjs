#!/usr/bin/env node
// Fallow baseline maintenance: coherent regeneration of every committed
// baseline, and a non-mutating freshness check (Gate D).
//
// Usage:
//   node bin/fallow-baseline.mjs update    regenerate committed baselines
//   node bin/fallow-baseline.mjs check     regenerate to a temp dir and diff
//
// Exit codes:
//   0 = success / fresh
//   1 = check found stale baselines
//   2 = analyzer/config error (never masked)

import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const COVERAGE = "coverage/coverage-final.json"
const DIR = "fallow-baselines"
// Combined-mode commands take --coverage at the top level; standalone health
// takes it after the subcommand.
const FILES = {
  "dead-code.json": ["--coverage", COVERAGE, "--save-baseline", `${DIR}/dead-code.json`],
  "health.json": ["health", "--coverage", COVERAGE, "--save-baseline", `${DIR}/health.json`, "--baseline-mode", "identity"],
  "dupes.json": ["dupes", "--save-baseline", `${DIR}/dupes.json`],
  "regression.json": ["--coverage", COVERAGE, "--save-regression-baseline", `${DIR}/regression.json`],
}

function fallow(args) {
  return spawnSync("pnpm", ["exec", "fallow", ...args], {
    encoding: "utf8",
  })
}

function run(cmd, { tolerateFindings = true } = {}) {
  const result = fallow(cmd)
  // exit 1 = findings exist (normal during baseline capture); 2 = real error.
  if (result.status === 2) {
    process.stderr.write(result.stdout || result.stderr)
    process.exit(2)
  }
  if (result.status === null) {
    process.stderr.write("fallow did not execute\n")
    process.exit(2)
  }
  return result.status
}

function requireCoverage() {
  if (!existsSync(COVERAGE)) {
    process.stderr.write(
      `error: ${COVERAGE} is missing; run \`pnpm test:coverage\` first so the health baseline captures real CRAP evidence\n`,
    )
    process.exit(2)
  }
}

// Volatile fields that must not count as staleness.
function normalize(contents, file) {
  const parsed = JSON.parse(contents)
  if (file === "regression.json") {
    delete parsed.timestamp
    delete parsed.git_sha
  }
  return parsed
}

function regenerate(targetDir) {
  requireCoverage()
  const written = {}
  for (const [file, cmd] of Object.entries(FILES)) {
    const target = join(targetDir, file)
    const mapped = cmd.map((a) => (a === `${DIR}/${file}` ? target : a))
    const status = run(mapped)
    written[file] = { path: target, status }
  }
  return written
}

function diffNormalized(aPath, bPath, file) {
  const a = normalize(readFileSync(aPath, "utf8"), file)
  const b = normalize(readFileSync(bPath, "utf8"), file)
  return JSON.stringify(a, null, 1) === JSON.stringify(b, null, 1)
}

const sub = process.argv[2]

if (sub === "update") {
  requireCoverage()
  for (const [file, cmd] of Object.entries(FILES)) {
    const status = run(cmd)
    console.log(`baseline ${file} saved (exit ${status})`)
  }
  console.log("Baselines regenerated. Commit fallow-baselines/ if they changed.")
  process.exit(0)
}

if (sub === "check") {
  const tmp = mkdtempSync(join(tmpdir(), "fallow-baseline-check-"))
  const stale = []
  try {
    const written = regenerate(tmp)
    for (const [file, { path }] of Object.entries(written)) {
      const committed = join(DIR, file)
      if (!existsSync(committed)) {
        stale.push(`${file} (missing)`)
        continue
      }
      const same = diffNormalized(path, committed, file)
      if (!same) stale.push(file)
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
  if (stale.length > 0) {
    console.error(
      `stale baseline(s): ${stale.join(", ")}. Regenerate with \`pnpm fallow:baseline:update\` and commit the improvement.`,
    )
    process.exit(1)
  }
  console.log("baseline check: fresh (regeneration matches committed baselines)")
  process.exit(0)
}

process.stderr.write(`usage: node bin/fallow-baseline.mjs update|check\n`)
process.exit(2)
