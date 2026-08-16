#!/usr/bin/env node
// Re-vendor the version-matched Fallow agent skill from the installed fallow
// package into .agents/skills/fallow, then update skills-lock.json.
//
// Usage: node bin/sync-fallow-skill.mjs [--check]
//
// The skill is package-owned: node_modules/fallow/skills/fallow is regenerated
// on every fallow upgrade, so the vendored copy must be refreshed in lockstep.

import { createHash } from "node:crypto"
import { cpSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const SRC = "node_modules/fallow/skills/fallow"
const DEST = ".agents/skills/fallow"
const LOCK = "skills-lock.json"

function hashDir(dir) {
  const hash = createHash("sha256")
  const walk = (path) => {
    for (const entry of readdirSync(path).sort()) {
      const full = join(path, entry)
      const rel = full.replace(`${dir}/`, "")
      if (statSync(full).isDirectory()) {
        walk(full)
      } else {
        hash.update(rel)
        hash.update(readFileSync(full))
      }
    }
  }
  walk(dir)
  return hash.digest("hex")
}

const { version } = JSON.parse(readFileSync("node_modules/fallow/package.json", "utf8"))
const computedHash = hashDir(SRC)
const checkOnly = process.argv.includes("--check")

const lock = JSON.parse(readFileSync(LOCK, "utf8"))
const lockEntry = lock.skills.fallow
const stale = !lockEntry || lockEntry.computedHash !== computedHash || lockEntry.version !== version

if (checkOnly) {
  if (stale) {
    console.error(
      `fallow skill is stale (installed fallow ${version}, vendored ${lockEntry?.version ?? "none"}). Run \`pnpm fallow:skill:sync\`.`,
    )
    process.exit(1)
  }
  console.log(`fallow skill is fresh (fallow ${version})`)
  process.exit(0)
}

cpSync(SRC, DEST, { recursive: true })
lock.skills.fallow = {
  source: "fallow",
  sourceType: "npm",
  version,
  computedHash,
}
writeFileSync(LOCK, `${JSON.stringify(lock, null, 2)}\n`)
console.log(`vendored fallow skill ${version} -> ${DEST}`)
