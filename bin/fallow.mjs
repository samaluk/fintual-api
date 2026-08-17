#!/usr/bin/env node

import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { resolve } from "node:path"

const ROOT = process.cwd()
const COVERAGE = resolve(ROOT, "coverage/coverage-final.json")

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

const command = process.argv[2]
if (command === "audit") process.exit(audit())

console.error("usage: node bin/fallow.mjs audit")
process.exit(2)
