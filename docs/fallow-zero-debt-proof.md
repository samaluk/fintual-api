# Fallow zero-debt gate proof

## Current gate: Fallow 3.26

The setup review rechecked the original reason for separate analyzers, then
compared the standalone commands with a combined full-repository run in disposable
TypeScript fixtures. No diagnostic changes were made to application source.

The canonical gate retains the strict changed-file audit and replaces the three
full-repository analyzers with:

```sh
fallow --format human --coverage coverage/coverage-final.json --fail-on-issues
```

The fixtures used the repository's type-aware completeness, entry-export,
private-type-leak, stale-suppression, duplication, and health policy, with minimal
entries and architecture zones. Controlled Istanbul fixtures isolated CRAP
behavior; real Vitest coverage remains the production gate's input.

| Probe | Combined exit | Evidence |
| --- | ---: | --- |
| Clean source with coverage | 0 | Complete semantic evidence; Istanbul coverage model |
| Unused entry export | 1 | `includeEntryExports` still enforced |
| Unused file | 1 | Full-repository reachability finding |
| Warning-severity unused dev dependency | 1 | `--fail-on-issues` rejects warnings too |
| Private type leak | 1 | Explicit error rule retained |
| Stale suppression | 1 | Explicit error rule retained |
| Boundary violation | 1 | Forbidden import rejected |
| Circular dependency | 1 | Cycle rejected |
| Cyclomatic threshold | 1 | Function exceeds the configured limit |
| CRAP with zero function coverage | 1 | Same function passes with full coverage |
| Missing configured tsconfig | 1 | Semantic evidence is unavailable, not silently rediscovered |
| Malformed tsconfig | 1 | Required semantic evidence is incomplete |
| Missing explicit coverage file | 2 | Input error remains fatal |
| Semantic and near clone groups | 1 | Positive native duplication threshold, described below |
| Both clone groups explicitly reviewed | 0 | Ignored fingerprints removed from groups and percentage |

## Rendering and duplication constraints

The probe matrix uncovered two behaviors that matter to a strict gate:

1. **Combined machine output does not enforce the ordinary findings exit.**
   `--format json --fail-on-issues` returned 0 for dead-code, warning-dependency,
   boundary, complexity, and CRAP findings. Human output returned 1. Missing
   coverage and incomplete type-aware evidence still failed in both formats.
   Therefore the canonical combined command explicitly pins `--format human`.
2. **The standalone duplication command's `--fail-on-issues` flag is inert.**
   Two used modules with semantic and near clones returned 0 in both standalone
   and combined modes. The isolated fixture disabled `duplicate-exports` so an
   unrelated export-name finding could not mask the duplication exit status.
   Setting `duplicates.threshold` to `5e-324`, the smallest positive f64,
   made both human gates return 1. Zero means disabled; this positive floor
   rejects every measurable nonzero duplication percentage. After ignoring both
   fingerprint/count pairs, the report had no groups, 0% duplication, and exit 0.

This fixes an existing full-repository duplication gap: the prior standalone
`dupes --fail-on-issues` command also passed clones, although the changed-file
audit still caught duplication in edited files. No baseline or percentage
allowance is introduced. Both limitations are recorded in the repository's Frog
log for upstream follow-up.

The upstream implementation confirms the format-specific behavior and native
threshold handling:

- [Combined output at v3.26.0](https://github.com/fallow-rs/fallow/blob/v3.26.0/crates/cli/src/combined/output.rs)
- [Duplication gate at v3.26.0](https://github.com/fallow-rs/fallow/blob/v3.26.0/crates/cli/src/dupes.rs)

## Why the previous composition existed

The [original zero-debt migration](https://github.com/samaluk/fintual-api/pull/405)
compared baseline ratchets with strict standalone gates under Fallow 3.17.
A combined command then accepted a nonexistent `typeAware.projects` path by
falling back to automatic discovery, while standalone health failed closed.
That justified keeping health separate at the time.

The 3.26 probes above supersede that restriction. They preserve the intended
zero-debt policy, with the newly discovered duplication and rendering constraints
made explicit. The type-aware completeness requirement, real coverage, semantic
and near duplication, reviewed clone exceptions, health thresholds, boundary
coverage, and entry-export analysis remain configured centrally.
