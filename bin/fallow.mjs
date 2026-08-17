#!/usr/bin/env node

import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const ROOT = process.cwd()
const COVERAGE = resolve(ROOT, "coverage/coverage-final.json")
const BASELINES = "fallow-baselines"
const BASELINE_COMMANDS = {
  "dead-code.json": ["--coverage", COVERAGE, "--coverage-root", ROOT, "--save-baseline"],
  "dupes.json": ["dupes", "--save-baseline"],
  "health.json": [
    "health",
    "--coverage",
    COVERAGE,
    "--coverage-root",
    ROOT,
    "--baseline-mode",
    "identity",
    "--save-baseline",
  ],
  "regression.json": [
    "--coverage",
    COVERAGE,
    "--coverage-root",
    ROOT,
    "--save-regression-baseline",
  ],
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: "inherit" })
  if (result.error) {
    console.error(result.error.message)
    return 2
  }
  return result.status ?? 2
}

function capture(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" })
  return result.status === 0 ? result.stdout.trim() : ""
}

function requireCoverage() {
  if (!existsSync(COVERAGE)) {
    console.error("coverage/coverage-final.json is missing; run `pnpm test:coverage` first")
    process.exit(2)
  }
}

function remoteRef(branch) {
  const ref = branch.startsWith("origin/") ? branch : `origin/${branch}`
  const branchName = ref.slice("origin/".length)
  const status = run("git", ["fetch", "--quiet", "origin", `${branchName}:refs/remotes/${ref}`])
  if (status !== 0) process.exit(status)
  return ref
}

function configuredBase() {
  if (process.env.FALLOW_AUDIT_BASE) return process.env.FALLOW_AUDIT_BASE
  return process.env.GITHUB_BASE_REF ? remoteRef(process.env.GITHUB_BASE_REF) : ""
}

function fallbackBase() {
  const defaultRef = capture("git", ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"])
  if (defaultRef) {
    console.warn(`warning: no PR base found; auditing against remote default ${defaultRef}`)
    return defaultRef
  }
  console.warn("warning: no PR base or remote default found; auditing against origin/main")
  return "origin/main"
}

function auditBase() {
  const configured = configuredBase()
  if (configured) return configured
  const prBase = capture("gh", ["pr", "view", "--json", "baseRefName", "--jq", ".baseRefName"])
  if (prBase) return remoteRef(prBase)
  return fallbackBase()
}

function fallow(args) {
  return run("pnpm", ["exec", "fallow", ...args])
}

function audit() {
  requireCoverage()
  const base = auditBase()
  console.log(`Fallow audit base: ${base}`)
  return fallow([
    "audit",
    "--base",
    base,
    "--coverage",
    COVERAGE,
    "--coverage-root",
    ROOT,
  ])
}

function regenerate(targetDir) {
  requireCoverage()
  for (const [file, args] of Object.entries(BASELINE_COMMANDS)) {
    const status = fallow([...args, join(targetDir, file)])
    if (status === 2) return status
  }
  return 0
}

function normalized(path, file) {
  const value = JSON.parse(readFileSync(path, "utf8"))
  if (file === "regression.json") {
    delete value.timestamp
    delete value.git_sha
  }
  return JSON.stringify(value)
}

function baselineCheck() {
  const directory = mkdtempSync(join(tmpdir(), "fallow-baseline-check-"))
  try {
    const status = regenerate(directory)
    if (status !== 0) return status
    const stale = Object.keys(BASELINE_COMMANDS).filter((file) => {
      const committed = join(BASELINES, file)
      const generated = join(directory, file)
      return !existsSync(committed) || normalized(committed, file) !== normalized(generated, file)
    })
    if (stale.length === 0) {
      console.log("Fallow baselines are fresh.")
      return 0
    }
    console.error(`stale Fallow baselines: ${stale.join(", ")}; run \`pnpm fallow:baseline:update\``)
    return 1
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

const command = process.argv[2]
if (command === "audit") process.exit(audit())
if (command === "baseline:update") process.exit(regenerate(BASELINES))
if (command === "baseline:check") process.exit(baselineCheck())

console.error("usage: node bin/fallow.mjs audit|baseline:update|baseline:check")
process.exit(2)
