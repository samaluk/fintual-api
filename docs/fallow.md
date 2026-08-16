# Fallow

`fintual-api` uses [Fallow](https://docs.fallow.tools) as a PR quality gate. On pull requests, `fallow audit` reviews the changed files for dead code, duplication, and complexity, and fails the build when a change introduces new findings (`gate: new-only`).

## Configuration

`.fallowrc.json` declares the analysis surface and the audit gate:

- `entry` — runtime entry points (`src/once.ts`, `bin/**/*.mjs`)
- `duplicates` — semantic mode with near-miss detection, `minLines: 8`, `minTokens: 60`, `minOccurrences: 3`
- `health` — cyclomatic (13), cognitive (16), CRAP (157), unit size (60)
- `audit` — `gate: new-only` with baselines for dead code, health, and duplication; scoped to `origin/main` via `FALLOW_AUDIT_BASE` so local runs match CI (the branch's own upstream would exclude files changed in earlier pushes)
- `typeAware` — TypeScript semantic analysis (symbol use, API surface, type coupling) runs for `dead-code`, `health`, `fix`, and the audit gate

Baselines live in `fallow-baselines/` and capture the current finding set, so pre-existing debt does not fail PRs. New findings in changed files do.

## Commands

```bash
pnpm fallow:audit      # PR gate: fails only on findings introduced by the change
pnpm fallow:baseline   # Regenerate all baselines after genuine fixes
pnpm fallow:diagnose   # Explain type-aware completeness without changing files
pnpm fallow:fix:preview  # Dry-run auto-fixes
pnpm fallow:fix        # Apply safe fixes (not run in CI)
```

## Inspecting findings

```bash
# Why is an export flagged?
pnpm exec fallow dead-code --trace src/env.ts:SomeExport

# Duplication fingerprint
pnpm exec fallow dupes --trace dup:<fingerprint>

# Health hotspots and targets
pnpm exec fallow health --hotspots --targets --ownership

# Explain an issue type
pnpm exec fallow explain unused-export
```

## Updating baselines after improvements

When you remove findings legitimately, regenerate and commit the baselines:

```bash
pnpm fallow:baseline
git add fallow-baselines/
```

The dead-code baseline is saved through the combined `fallow` run so its analysis identity (including `type-coupling`) matches what the audit gate produces.

Always use `pnpm fallow:baseline`; do not assemble individual
`--save-baseline` commands. The repository script preserves the analysis modes
and baseline identities expected by the audit gate.

Regenerating a worse baseline to silence CI is not acceptable — fix the code or justify narrow config changes.

## Diagnosing partial type-aware analysis

With `typeAware.require: complete`, a bounded or unsupported semantic query is a
gate failure even when the underlying code is valid. Start with:

```bash
pnpm fallow:diagnose
```

The command prints the project identity and every incomplete query with its gap
reason and subject. It does not update baselines. Investigate in this order:

1. Trace newly exported symbols. An implementation-only class or helper should
   normally remain module-local.
2. Inspect queries whose gap reason is `evidence-limit`. This is a bounded-tool
   result, not proof that the referenced member is dead. Do not reshape tests or
   production code merely to reduce legitimate references.
3. Compare the project configuration hash with the committed dead-code baseline.
   A deliberate tsconfig change requires a baseline refresh only after the
   analysis is complete.
4. Treat config-only dependencies as narrow `ignoreDependencies` entries when
   they are genuinely used by lifecycle scripts or compiler configuration but
   have no import edge.
5. Use `fallow dead-code --trace <file>:<export>` for a specific symbol before
   changing code or baselines.

If the result stays partial because of an analyzer bound or unsupported relation,
run `pnpx frog list` and record new repository friction with `pnpx frog log`.

## CI behavior

`pnpm fallow:audit` runs in the `CI` workflow (`.github/workflows/pr-check.yml`) on every pull request and on pushes to `main`. It fails only when the change introduces new findings.
