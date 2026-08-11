# Fallow

`fintual-api` uses [Fallow](https://docs.fallow.tools) as a PR quality gate. On pull requests, `fallow audit` reviews the changed files for dead code, duplication, and complexity, and fails the build when a change introduces new findings (`gate: new-only`).

## Configuration

`.fallowrc.json` declares the analysis surface and the audit gate:

- `entry` — runtime entry points (`src/once.ts`, `bin/**/*.mjs`)
- `ignorePatterns` — `scripts/**`, `.github/**`
- `duplicates` — semantic mode, `minLines: 8`, `minTokens: 60`, `minOccurrences: 3`
- `health` — cyclomatic (13), cognitive (16), CRAP (157), unit size (60)
- `audit` — `gate: new-only` with baselines for dead code, health, and duplication
- `typeAware` — TypeScript semantic analysis (symbol use, API surface, type coupling) runs for `dead-code`, `health`, `fix`, and the audit gate

Baselines live in `fallow-baselines/` and capture the current finding set, so pre-existing debt does not fail PRs. New findings in changed files do.

## Commands

```bash
pnpm fallow:audit      # PR gate: fails only on findings introduced by the change
pnpm fallow:baseline   # Regenerate all baselines after genuine fixes
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

Regenerating a worse baseline to silence CI is not acceptable — fix the code or justify narrow config changes.

## CI behavior

`pnpm fallow:audit` runs in the `CI` workflow (`.github/workflows/pr-check.yml`) on every pull request and on pushes to `main`. It fails only when the change introduces new findings.
