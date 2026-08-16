# Fallow

`fintual-api` runs [Fallow](https://docs.fallow.tools) as a strict, comprehensive
quality ratchet: existing debt is baselined, new debt is rejected, and debt may
only move downward. The setup follows the same policy shape used across
repositories; repository-specific details (entry points, architecture zones,
generated files, exclusions) live here.

## Purpose / quality-ratchet model

Four complementary guarantees, each backed by a Fallow mechanism:

| Gate | What it catches | Mechanism |
| --- | --- | --- |
| **A — changed-code audit** | Findings introduced by the current changeset | `fallow audit` with `gate: new-only`, type-aware, against the `origin/main` merge base |
| **B — identity baselines** | Any new finding anywhere, including a swap (one removed + one different added at the same count) | `--baseline` comparison per analysis |
| **C — regression counts** | Aggregate issue-count increases | `--fail-on-regression` against a committed count baseline |
| **D — baseline freshness** | Baselines not updated after code improved | regeneration to a temp dir + diff (`fallow:baseline:check`) |

The result: worse → fails analysis; better but baseline unchanged → fails
freshness; better + baseline reduced → passes. Never regenerate a worse
baseline to silence CI.

## Fallow version

Pinned exact: `fallow: 3.16.0` in `devDependencies`. The GitHub Action
(`.github/workflows/pr-check.yml`) pins the same release commit and passes
`version: 3.16.0`. Always use the project-local binary (`pnpm exec fallow` /
`pnpm fallow:*`), never a global install.

## Enabled analyses

- **Dead code / dependency graph** — unused files, exports, types, enum and
  class members, dependencies, optional dependencies; unresolved and unlisted
  dependencies; duplicate exports; circular dependencies and re-export cycles;
  type-only/test-only dependency issues; private type leaks (`error`);
  stale suppressions (`error`); boundary violations (`error`).
- **Type-aware analysis** — see below.
- **Duplication** — semantic mode with near-miss detection (`near: true`),
  `minLines: 8`, `minTokens: 60`, `minOccurrences: 3`, `ignoreImports`.
  Pair-level clones at these thresholds are overwhelmingly Effect framework
  boilerplate (`Schema.TaggedError` declarations, `Context.Service` + layer
  scaffolding) that is intentional and not safely extractable, so
  `minOccurrences: 3` is kept as the detection floor.
- **Health / complexity** — cyclomatic (13), cognitive (15), CRAP (30),
  unit size (60). Thresholds are stricter than or equal to Fallow defaults.
  A narrow `thresholdOverrides` entry raises CRAP only for two named
  repo-tooling verdict functions in `bin/fallow-ci.mjs` (untested by design;
  see "Intentional exclusions").
- **Architecture boundaries** — see below.
- **Security** — exposed as `pnpm fallow:security` (advisory candidates for
  agent verification, not a binary gate). No security categories are enabled
  in config; defaults apply.
- **Feature flags, CSS/styling, rule packs** — not applicable: this is a
  backend worker with no UI framework, no CSS, and no flag SDK. No rule pack is
  defined because the repository has no policy invariant that a declarative
  pack would express beyond the boundary rules already enforced.

## Type-aware configuration / completeness

```jsonc
{
  "typeAware": { "enabled": true, "require": "complete", "projects": ["tsconfig.json"] },
  "audit": { "typeAware": true }
}
```

`require: complete` fails the gate when a requested semantic query is
incomplete. Check companion availability with `pnpm fallow:status`. The
type-aware sidecar is the version-matched `fallow-type-aware` installed with
the `fallow` package; `pnpm fallow:status` verifies discovery and version.

Completeness is verified in every gate run (each analysis carries its identity;
incomplete runs exit 2). The committed baselines record the type-aware identity
(`project_config_hash`) they were saved under, so a config or tsconfig change
that shifts the identity fails Gate D until baselines are refreshed — the
intended migration path.

## Architecture boundaries

The Effect-first architecture (see `docs/adr/0000-effect-first-application-architecture.md`)
splits the source into replaceable external-system adapters and a shared core:

| Zone | Patterns |
| --- | --- |
| `adapter-actual` | `src/actual/**` |
| `adapter-fintual` | `src/fintual/**` |
| `shared` | `src/env.ts`, `src/log.ts`, `src/logging.ts`, `src/log-test-fixtures.ts`, `src/performance-snapshot.ts` |
| `app` | `src/*.ts` |

Rules: adapters may only import from `shared` (never each other, never
orchestration); `app` may import `shared` and both adapters. All source files
must belong to a zone (`boundaries.coverage.requireAllFiles: true`);
`bin/**` and `vitest.config.ts` are unmatched by design. Boundary violations
are `error` severity. Inspect with:

```bash
pnpm exec fallow list --boundaries
pnpm exec fallow guard <files>          # rules that apply before editing
```

## Baseline layers

All baselines live in `fallow-baselines/` (committed):

- `dead-code.json` — saved through the combined `fallow` run so its analysis
  identity (including `type-coupling`) matches what the audit gate produces.
  This is why the standalone `fallow dead-code --baseline` command cannot
  consume it; Gate B compares it via the combined run instead
  (`bin/fallow-ci.mjs`).
- `health.json` — saved with `--baseline-mode identity` so a replacement
  hotspot is reported instead of silently consuming an old allowance.
- `dupes.json` — clone-group fingerprints.
- `regression.json` — issue-count baseline for Gate C.

The audit gate's per-analysis baselines are wired in `audit.*Baseline`.
Regenerating all baselines coherently is `pnpm fallow:baseline:update`; it
requires `coverage/coverage-final.json` (run `pnpm test:coverage` first).

## Local commands

```bash
pnpm fallow                    # combined exploration run (dead-code + dupes + health)
pnpm fallow:config             # resolved config
pnpm fallow:recommend          # project-tailored config recommendation
pnpm fallow:status             # type-aware companion status
pnpm fallow:audit              # Gate A: changed-code audit vs origin/main (uses coverage when present)
pnpm fallow:audit:staged       # Gate A vs HEAD (pre-commit hook; uses coverage when present)
pnpm fallow:dead-code          # Gate B: dead-code identity baseline
pnpm fallow:dupes              # Gate B: duplication identity baseline
pnpm fallow:health             # Gate B: health identity baseline (needs coverage)
pnpm fallow:regression         # Gate C: regression count ratchet (needs coverage)
pnpm fallow:baseline:update    # regenerate all baselines coherently (needs coverage)
pnpm fallow:baseline:check     # Gate D: baseline freshness (needs coverage)
pnpm fallow:security           # advisory security candidates
pnpm fallow:suppressions       # suppression inventory
pnpm fallow:fix:preview        # dry-run auto-fixes
pnpm fallow:fix                # apply safe fixes (never in CI)
pnpm fallow:ci                 # authoritative full ratchet (Gates A–D)
pnpm fallow:skill:sync         # re-vendor the agent skill after a fallow upgrade
```

`pnpm fallow:ci` is the local equivalent of the CI gate: it runs every gate,
reports per-gate status, and exits 0 (clean), 1 (findings), or 2 (error). It
requires `coverage/coverage-final.json`; run `pnpm test:coverage` first. The
audit gate pins `FALLOW_AUDIT_BASE` (default `origin/main`) so local and
pre-push runs scope to the same merge base CI uses — on an already-pushed
feature branch, the branch's own upstream would otherwise hide findings
introduced by earlier commits.

## CI behavior

`.github/workflows/pr-check.yml`:

- **`check` job** — lint, typecheck, format, `pnpm test:coverage`, then
  `pnpm fallow:ci` (the authoritative ratchet). Fail-fast on any gate.
- **`fallow` job** — the official `fallow-rs/fallow` Action pinned to the
  v3.16.0 release commit with `version: 3.16.0`, running `command: audit`
  with `gate: new-only`, type-aware, coverage, and the same baselines. It
  emits inline annotations, a sticky PR comment, and uploads SARIF to GitHub
  Code Scanning. Its purpose is PR-visible feedback; the check job owns the
  deeper ratchet.

CI fails when: changed code introduces a forbidden finding (Gate A); an exact
baseline is exceeded (Gate B); regression counts increase (Gate C); committed
baselines are stale (Gate D); or config/type-aware analysis errors (exit 2).

## Git-hook behavior

`hk.pkl` (hk, the repository's hook manager — no competing manager is
installed):

- `pre-commit` — Oxfmt and Oxlint on staged TypeScript (fix + re-stage), plus
  `fallow:audit:staged` (fast changed/staged-code audit vs `HEAD`, rejecting
  newly introduced findings). Uses coverage when it exists; falls back to the
  coverage-less audit otherwise.
- `pre-push` — Oxfmt, Oxlint, typecheck, `pnpm test:coverage`, then
  `pnpm fallow:ci` (the full ratchet), with `fallow:ci` depending on the test
  step so coverage exists.

## Agent / MCP integration

- The version-matched Fallow agent skill is vendored at
  `.agents/skills/fallow` from the installed package
  (`node_modules/fallow/skills/fallow`). Regenerate after a fallow upgrade
  with `pnpm fallow:skill:sync` (also updates `skills-lock.json`).
- Repository-local MCP: `.mcp.json` exposes `fallow-mcp` via
  `pnpm exec fallow-mcp` for Claude Code and other harnesses that read it.
- `AGENTS.md` points agents at the skill and the standardized commands; it
  does not duplicate the upstream skill.

## Coverage behavior

`pnpm test:coverage` (Vitest with `@vitest/coverage-v8`) writes
`coverage/coverage-final.json`. Fallow consumes it via `--coverage` (or the
`health.coverage`/`FALLOW_COVERAGE` equivalents) for real per-function CRAP
evidence in `fallow:health`, `fallow:audit`, and the baseline commands. The
health baseline is generated and enforced under the same coverage model; gate
runs require the coverage file and fail loudly (exit 2) when it is missing,
rather than silently comparing coverage-aware baselines against a
coverage-less run. `coverage/` is gitignored.

The paid Fallow Runtime (production runtime coverage) is intentionally not
used. It would add hot/cold-path production evidence to `fallow health`; if it
becomes desirable, it is a future extension — activate only with explicit
authorization (license, no trial side effects in this repository).

## Intentional exclusions and their reasons

- `ignoreDependencies: ["@effect/tsgo"]` — the TypeScript compiler used via
  the `prepare` script / toolchain; it has no import edge but is not unused.
- `boundaries.coverage.allowUnmatched: ["bin/**", "vitest.config.ts"]` —
  repo tooling and test configuration, outside the runtime architecture.
- `health.thresholdOverrides` — `maxCrap: 60` for `auditVerdict` and
  `regressionVerdict` in `bin/fallow-ci.mjs`: repo-tooling orchestrator
  verdicts with no test coverage by design; their cyclomatic/cognitive
  complexity is well below the ceilings. Scoped to those two named functions
  only (the override rows report `active`, never `stale`).
- `dynamicallyLoaded: ["bin/fintual-goal-performance.graphql"]` — a runtime
  file loaded by the HAR-capture tooling, not an import edge.
- Security categories: not configured beyond defaults; `fallow security`
  remains advisory.

## How to investigate a finding

```bash
# Why is an export flagged?
pnpm exec fallow dead-code --trace src/env.ts:SomeExport

# Exact TypeScript consumers (aliases, re-exports, tests) before deleting
pnpm exec fallow dead-code --type-aware --symbol-impact src/env.ts:SomeExport

# Which files/dependencies does deleting this affect?
pnpm exec fallow dead-code --trace-file src/actual.ts
pnpm exec fallow dead-code --trace-dependency <name>

# Duplication fingerprint
pnpm exec fallow dupes --trace dup:<fingerprint>

# Health hotspots and refactoring targets
pnpm exec fallow health --hotspots --targets --ownership

# Boundary rules that apply to a file before editing
pnpm exec fallow guard <files>

# Suppression inventory
pnpm exec fallow suppressions

# Explain an issue type
pnpm exec fallow explain unused-export
```

## How to update baselines after improvements

```bash
pnpm test:coverage                # coverage first (baselines are coverage-aware)
pnpm fallow:baseline:update       # regenerate every committed baseline coherently
git add fallow-baselines/         # commit the improvement
```

`fallow:baseline:update` is the only supported way to refresh baselines; it
preserves the analysis modes and identities the gates enforce. Regenerating a
worse baseline to silence CI is not acceptable — fix the code or justify a
narrow config change. Baseline-update commands never mask analyzer errors
(exit 2 propagates).

## Known upstream limitations

- **Dead-code baseline identity**: the committed dead-code baseline is saved
  through the combined `fallow` run so its identity (including
  `type-coupling`) matches the audit gate. Standalone `fallow dead-code
  --baseline` requests a narrower capability set and rejects that baseline
  (exit 2). Gate B therefore compares dead code via the combined run
  (`bin/fallow-ci.mjs`), and changed-code dead-code gating relies on the
  audit's own base-snapshot attribution. This is the documented Fallow
  identity contract; do not hack around it.
- **Combined-run exit codes**: the bare `fallow` command's `--fail-on-issues`
  exit semantics differ between `--format json` (0 even with findings) and
  other formats. `bin/fallow-ci.mjs` therefore parses JSON verdict fields
  rather than relying on the combined command's exit code. Individual
  subcommands (`dead-code`, `dupes`, `health`, `audit`) have reliable exit
  semantics.
- **Evidence limits**: a bounded-tool result (`evidence-limit`) marks type-aware
  queries incomplete even when the code is valid; `require: complete` then
  fails the run. Do not reshape valid code to reduce legitimate references —
  investigate with `pnpm fallow:status` / traces and record friction.
