# Fallow

`fintual-api` uses Fallow 3.17.0 as a strict zero-debt quality gate. The
repository is clean, so CI rejects every finding directly; it does not carry
identity, regression, or freshness baselines.

The negative-test evidence for this architecture is recorded in
[`fallow-zero-debt-proof.md`](fallow-zero-debt-proof.md). In particular, the
project-wide gate deliberately composes standalone dead-code, duplication, and
health commands. A single combined command can silently recover from a missing
configured tsconfig path, while standalone health fails closed because
`typeAware.require: "complete"` cannot be satisfied.

## Version and native integration

`package.json` pins `fallow` exactly to 3.17.0. The official GitHub Action is
pinned to the immutable 3.17.0 release commit and receives `version: 3.17.0`, so
the local binary, type-aware companion, skill, CI gate, and PR renderer stay in
lockstep. Always use `pnpm exec fallow` or the repository scripts, never a
global installation.

Fallow 3.17 supplies every orchestration behavior this repository needs. There
is no local wrapper: native audit base discovery uses `FALLOW_AUDIT_BASE` when
CI sets it and otherwise resolves the merge base against the branch upstream or
remote default. A missing coverage file is a native exit-2 error.

## Enforced analyses

- Dead code, dependency placement, unresolved imports, duplicate exports,
  circular dependencies, re-export cycles, architecture boundaries, private
  type leaks, and stale suppressions.
- Entry-file exports (`includeEntryExports: true`). Enabling this found an
  unnecessary `main` export in `src/main.ts`; it is now private while the entry
  point behavior remains unchanged.
- Type-aware analysis against `tsconfig.json`, with completeness required.
- Semantic and near-miss duplication at two occurrences, eight lines, and 60
  tokens. Four reviewed pair fingerprints are ignored until their content or
  occurrence count changes: three are distinct `Schema.TaggedError` declaration
  sequences and one is small symmetric Actual API adapter wiring.
- Health thresholds: cyclomatic 13, cognitive 15, CRAP 30, and unit size 60.
  Real Istanbul coverage feeds CRAP scoring.
- Boundary coverage for every analyzed source file.

Security candidates remain an advisory agent-verification command. Feature
flags, CSS analysis, and rule packs are not enabled because this backend worker
has no corresponding surface or repository policy. Effect-specific rule-pack
checks are a future opportunity if a stable invariant emerges that the existing
boundaries cannot express.

## Gate shape

`pnpm fallow:ci` runs four native commands in order:

1. coverage-aware `fallow audit --gate all` against the branch base;
2. full-repository `fallow dead-code --fail-on-issues`;
3. full-repository `fallow dupes --fail-on-issues`;
4. coverage-aware `fallow health --fail-on-issues`.

The audit rejects every finding in changed files. The three standalone
full-repository commands keep the already-clean repository clean and remove any
same-count debt-swap allowance. Exit codes are native: 0 is clean, 1 means
findings, and 2 means an analyzer or configuration failure.

## Commands

```bash
pnpm fallow                    # exploratory combined analysis
pnpm fallow:config             # resolved configuration
pnpm fallow:recommend          # project-specific recommendations
pnpm fallow:status             # type-aware companion status
pnpm fallow:audit              # coverage-aware strict changed-file audit
pnpm fallow:audit:staged       # fast strict staged-file audit vs HEAD
pnpm fallow:dead-code          # strict full-repository dead-code gate
pnpm fallow:dupes              # strict full-repository duplication gate
pnpm fallow:health             # strict coverage-aware health gate
pnpm fallow:security           # advisory security candidates
pnpm fallow:suppressions       # suppression inventory
pnpm fallow:fix:preview        # dry-run safe fixes
pnpm fallow:fix                # apply safe fixes; never used in CI
pnpm fallow:ci                 # authoritative composed quality gate
```

Generate `coverage/coverage-final.json` with `pnpm test:coverage` before the
coverage-aware commands.

## CI and PR feedback

`.github/workflows/pr-check.yml` has four complementary jobs:

- `Lint, typecheck & format` runs the static checks.
- `Test with coverage` runs the suite once and uploads the shared coverage
  evidence.
- `Fallow gate` runs the authoritative `pnpm fallow:ci` gate using that evidence.
- `Fallow PR review` runs one type-aware, coverage-aware audit through the
  pinned official Action. Fallow 3.17 renders the saved JSON envelope natively
  as a compact sticky summary, a Check Run, inline review comments, and review
  guidance. It does not perform a second analysis and does not use SARIF or
  GitHub Code Scanning.

The two Fallow jobs analyze with `gate: all`, semantic/near duplication, and
the same Istanbul coverage evidence. The Action receives the GitHub workspace
as `coverage-root`; native audit forwards the evidence to base analysis so HEAD
and base use the same coverage model.

## Version drift enforcement

`.github/workflows/fallow-drift.yml` runs the same covered full gate once for
each exact Fallow version newly resolved in `pnpm-lock.yaml`. It triggers when a
push to `main` changes `package.json` or `pnpm-lock.yaml`, and it can be started
manually. There is no cron because the analyzer cannot change while the exact
locked version remains unchanged; unrelated dependency changes trigger only a
cache-hit no-op.

The lockfile version keys an `actions/cache` marker. On a miss, the workflow
sets up the pinned Node.js and pnpm versions, installs with
`--frozen-lockfile`, confirms the installed CLI matches the cache key,
regenerates `coverage/coverage-final.json`, and runs `pnpm fallow:ci`. The
marker is written after the gate, and GitHub saves a new cache only after the
job succeeds. Install, coverage, or analyzer failures therefore remain
uncached and retryable on the next qualifying push or manual dispatch.

This is not a second Action-based approximation: it executes the same package
script and real-coverage contract as CI and pre-push. Local mechanics evidence
is recorded in [`fallow-drift-proof.md`](fallow-drift-proof.md).

## Git hooks

`hk.pkl` is the sole hook manager:

- `pre-commit` formats and lints staged TypeScript, re-stages safe fixes, and
  runs the fast coverage-free strict audit against `HEAD`.
- `pre-push` runs formatting, linting, TypeScript, tests with coverage, and the
  complete `fallow:ci` gate. The Fallow step depends on coverage generation.

## Architecture boundaries

The Effect-first architecture has four application zones:

| Zone | Patterns |
| --- | --- |
| `adapter-actual` | `src/actual/**` |
| `adapter-fintual` | `src/fintual/**` |
| `shared` | `src/env.ts`, `src/log.ts`, `src/logging.ts`, `src/log-test-fixtures.ts`, `src/performance-snapshot.ts` |
| `app` | `src/*.ts` |

Adapters may import only `shared`. Application orchestration may import
`shared` and either adapter. `requireAllFiles: true` makes new unclassified
files fail unless they match the intentional tooling exclusions below.

Inspect the rules before editing with:

```bash
pnpm exec fallow list --boundaries
pnpm exec fallow guard <files>
```

## Coverage decisions

Vitest writes real Istanbul data to `coverage/coverage-final.json`. Fallow uses
it for exact per-function CRAP evidence in audit and health. The gate fails
loudly when the file is absent.

`fallow health --coverage-gaps` was evaluated but remains advisory. Before the
two process modes were consolidated, it reported the one-shot entry module, two
HAR helper modules, and the GraphQL document because none had a static
dependency path from a test root. The one-shot entry is now part of `src/main.ts`;
importing process entry points merely to satisfy this structural heuristic would
not test useful behavior. Their domain workflows are exercised at narrower
boundaries. The real Istanbul signal remains blocking through CRAP scoring.

## Intentional configuration

Each retained exception was removed and reprobed under Fallow 3.17:

- `ignoreDependencies: ["@effect/tsgo"]` is required because the package
  supplies the `effect-tsgo` binary used by `prepare` and has no import edge;
  without the exception Fallow reports a false unused-dev-dependency finding.
- `dynamicallyLoaded: ["bin/fintual-goal-performance.graphql"]` represents the
  GraphQL file loaded through `fs`; without it Fallow reports the live document
  as unused.
- `entry: ["bin/**/*.mjs"]` keeps the two shell/runtime-invoked helper modules
  reachable. Without the entry glob, both helper modules are reported unused.
- `boundaries.coverage.allowUnmatched: ["bin/**", "vitest.config.ts"]` keeps
  repository tooling outside the four runtime architecture zones. Removing
  either exclusion produces boundary-coverage failures for those files.

The `@actual-app/api` workflow-expression glob warnings are a known upstream
parser limitation tracked in issue #331; they are noisy but do not weaken a
verdict.

## Release-age policy

`pnpm-workspace.yaml` keeps strict release-age handling for packages not listed
in `minimumReleaseAgeExclude`. The long-lived Actual exceptions support their
coordinated release workflow; `fallow`, `fallow-type-aware`, and
`@fallow-cli/*` are also explicitly excluded, so the age window does not delay
those packages. The drift workflow does not resolve or upgrade dependencies: it
uses the already-committed lockfile and a frozen install. It therefore scans the
exact Fallow version admitted by the repository's dependency policy, while
`minimumReleaseAgeStrict` continues to govern non-excluded dependencies.

## Investigating findings

```bash
pnpm exec fallow dead-code --trace src/env.ts:SomeExport
pnpm exec fallow dead-code --type-aware --symbol-impact src/env.ts:SomeExport
pnpm exec fallow dead-code --trace-file src/actual.ts
pnpm exec fallow dead-code --trace-dependency <name>
pnpm exec fallow dupes --trace src/file.ts:<line>
pnpm exec fallow health --hotspots --targets --ownership
pnpm exec fallow guard <files>
pnpm exec fallow suppressions
pnpm exec fallow explain unused-export
```

Before deleting code or dependencies, trace the exact consumers. Treat partial
or unavailable type-aware evidence as a reason to preserve the symbol, not as
deletion proof.
