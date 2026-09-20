# Fallow

Fallow is a strict zero-debt gate: every unignored finding blocks delivery.
There are no identity or regression baselines. `.fallowrc.json` owns analysis
policy; `package.json` owns the exact CLI version and the three project commands.
Use the installed binary through `pnpm exec fallow`.

## Gate and hooks

`pnpm fallow:ci` runs two native commands:

1. `fallow audit --coverage coverage/coverage-final.json` checks changed files
   with the configured `audit.gate: all` policy.
2. `fallow --format human --coverage coverage/coverage-final.json --fail-on-issues`
   checks dead code, duplication, and health across the whole repository.

The combined run now preserves complete type-aware evidence, including failure
on a missing configured tsconfig. The former standalone composition is no longer
needed for that protection. See the current
[negative-test evidence](fallow-zero-debt-proof.md).

Two upstream behaviors need explicit settings:

- **Keep `--format human` on the full gate.** Combined JSON and other machine
  renderers can exit successfully despite findings, even with `--fail-on-issues`.
  JSON remains useful for inspection and the official Action's verdict handling.
- **Keep `duplicates.threshold: 5e-324`.** `dupes --fail-on-issues` does not reject
  clones, and a zero threshold disables its native gate. The smallest positive
  f64 rejects any measurable duplication, without percentage headroom. Reviewed
  `ignoredClones` are removed before the percentage is computed. This narrow
  workaround is recorded in the proof and Frog friction log.

`hk.pkl` remains the only hook manager. Pre-commit formats and lints staged
TypeScript, re-stages safe fixes, and runs the coverage-free audit against
`HEAD`. Pre-push generates real test coverage before running `fallow:ci`, alongside
the repository's formatting, linting, and type checks. Full verification belongs
at this hook boundary; focused diagnostic probes are appropriate during changes.

| Command | Purpose |
| --- | --- |
| `pnpm fallow:audit:staged` | Coverage-free audit against `HEAD`, used with hk's staged-change isolation |
| `pnpm fallow:audit` | Coverage-aware audit against the branch base |
| `pnpm fallow:ci` | Covered changed-file audit and full-repository gate |

Coverage-aware commands require `coverage/coverage-final.json` from Vitest.
Missing explicit coverage is an analyzer error, not a fallback to estimated
coverage. Audit base discovery honors `FALLOW_AUDIT_BASE`, then the merge base
against the upstream or remote default. CI pins the base explicitly.

## Enforced policy

- Dead code, dependency placement, unresolved imports, duplicate exports,
  circular dependencies, re-export cycles, architecture boundaries, entry-file
  exports, private type leaks, and stale suppressions.
- Type-aware analysis of `tsconfig.json`, with completeness required.
- Semantic and near duplication at two occurrences, eight lines, and 60 tokens.
  Two reviewed fingerprint/count exceptions cover distinct tagged-error
  declaration sequences in the Actual and Fintual adapters. The obsolete four
  keys from the previous analyzer were replaced after reviewing current output.
- Health limits: cyclomatic 13, cognitive 15, CRAP 30, and unit size 60.
  Real Istanbul coverage feeds CRAP scoring.
- Architecture boundary coverage for every analyzed source file.

Security candidates and structural coverage gaps remain advisory. Runtime
coverage, security gates, feature flags, CSS analysis, and rule packs are not
added merely because newer Fallow releases support them.

## CI and version maintenance

The four required jobs in `.github/workflows/pr-check.yml` remain:

- **Lint, typecheck & format** runs static checks.
- **Test with coverage** runs tests once and uploads Istanbul coverage.
- **Fallow gate** runs the same `fallow:ci` command as pre-push.
- **Fallow PR review** runs the official Action's audit using the shared coverage,
  then renders a compact sticky summary, Check Run, inline comments, and review
  guidance from that result. SARIF is disabled by default.

The Action reads the exact Fallow version from `package.json` and provisions
its matching type-aware companion automatically from `.fallowrc.json`. Gate,
semantic/near duplication, and type-aware policy also come from that config.
The immutable Action release pin must stay aligned with the package; Renovate
groups their updates. The agent skill symlink under `.agents/skills/fallow`
always reads the installed package's guidance.

`.github/workflows/fallow-drift.yml` runs the same covered gate once per newly
resolved lockfile version, on qualifying `main` pushes or manual dispatches
against `main`. Its version-keyed success marker is cached only after a frozen
install, fresh coverage, and a passing gate; failures remain retryable. No cron
is needed for an exactly pinned analyzer. See the original
[drift workflow evidence](fallow-drift-proof.md).

Fallow packages are explicitly excluded from pnpm's release-age window, as
recorded in `pnpm-workspace.yaml`. Frozen installs still use the committed
lockfile; the drift workflow never resolves an upgrade itself.

## Repository-specific configuration

| Zone | Patterns | May import |
| --- | --- | --- |
| `adapter-actual` | `src/actual/**` | `shared` |
| `adapter-fintual` | `src/fintual/**` | `shared` |
| `shared` | `src/env.ts`, `src/log.ts`, `src/logging.ts`, `src/log-test-fixtures.ts`, `src/performance-snapshot.ts` | No extra zone rule |
| `app` | `src/*.ts` | `shared` and both adapters |

`requireAllFiles: true` rejects unclassified source files. `bin/**` and
`vitest.config.ts` are intentional tooling exclusions. Other explicit entries
and exceptions represent usage the analyzer cannot infer:

- `bin/**/*.mjs` includes shell/runtime-invoked helper modules.
- `bin/fintual-goal-performance.graphql` is loaded through `fs`.
- `@effect/tsgo` provides the `effect-tsgo` binary used by `prepare`.

## Investigation

Use native commands instead of maintaining package aliases for each operation:

```bash
pnpm exec fallow config
pnpm exec fallow recommend
pnpm exec fallow type-aware status
pnpm exec fallow dead-code --trace src/env.ts:SomeExport
pnpm exec fallow dead-code --type-aware --symbol-impact src/env.ts:SomeExport
pnpm exec fallow dead-code --trace-dependency <name>
pnpm exec fallow dupes --trace src/file.ts:<line>
pnpm exec fallow health --hotspots --targets --ownership
pnpm exec fallow guard <files>
pnpm exec fallow suppressions
pnpm exec fallow explain unused-export
pnpm exec fallow fix --dry-run
```

Trace exact consumers before deleting code or dependencies. Partial semantic
evidence is not deletion proof. For machine inspection, follow the installed
skill's JSON guidance and inspect findings as well as status; do not replace
the canonical gate with a machine-rendered combined command. Read
`pnpm exec fallow schema` for the current exit-code contract.
