# Fallow zero-debt gate proof

This document records the negative-test evidence used to replace Fallow identity
and regression baselines with a strict, baseline-free full-repository gate. The
repository was clean before the experiment, so every injected finding was new
debt.

## Compared architectures

The experiments ran in a disposable worktree at commit `65be0c5`. Each case was
restored before the next one.

- **A — baseline ratchet:** the existing standalone dead-code, duplication, and
  health identity-baseline checks, followed by the count regression check.
- **B — zero-debt gate:** standalone dead-code, duplication, and health commands,
  each using `--fail-on-issues`; health received the same Istanbul coverage file
  as the previous gate.

The standalone shape matters. A single bare combined `fallow --fail-on-issues`
run is not equivalent to B; the configuration-drift probe below explains why.

## Negative-test matrix

| # | Injected violation | A | B | Result |
|---:|---|:---:|:---:|---|
| 1 | Unused export | Fail | Fail | Same finding |
| 2 | Unused file | Fail | Fail | Same finding |
| 3 | Unused dependency | Fail | Fail | All usages, including `bin/`, were removed |
| 4 | Circular dependency | Fail | Fail | Same finding |
| 5 | Boundary violation | Fail | Fail | Same finding |
| 6 | Complexity violation | Fail | Fail | Same finding |
| 7 | Three-copy duplication | Fail | Fail | Same `dup:6f87acd9` group |
| 8 | Warning-severity unused dev dependency | Fail | Fail | `--fail-on-issues` also rejects warnings |
| 9 | Re-export cycle | Fail | Fail | Accompanied by a circular-dependency error |
| 10 | Type-only dependency | Not applicable | Not applicable | The dependency remained value-used elsewhere |
| 11 | Private type leak | Fail | Fail | Same finding |
| 12 | Stale suppression | Fail | Fail | Same finding |
| 13 | Broken tsconfig contents | Fail | Fail | Both fail closed |
| 14 | Missing configured tsconfig path | Fail | Fail | Only with standalone health; see below |
| 15 | Unused export in an entry file | Miss | Miss | Addressed separately with `includeEntryExports` |
| 16 | Remove one finding and add another | Fail | Fail | Zero debt provides no count-based swap allowance |

Two baseline-only checks were also exercised. The regression gate failed when a
finding was added, and baseline freshness failed when a committed baseline was
made stale. Both are redundant when the strict standalone commands reject every
finding directly.

## Configuration-drift probe

Changing `typeAware.projects` to a nonexistent tsconfig uncovered the only
architectural divergence:

- a bare combined `fallow --fail-on-issues` run returned success after silently
  falling back to automatic project discovery;
- standalone `fallow dead-code --fail-on-issues` also returned success;
- standalone `fallow health --fail-on-issues` failed because its type-coupling
  query reported `no-project`, which violates `typeAware.require: "complete"`;
- `fallow audit --fail-on-issues` also failed closed.

Therefore the baseline-free CI gate must remain a composition of standalone
dead-code, duplication, and health commands. In particular, health cannot be
folded into a single combined run without making a broken configured project
path undetectable.

## Conclusion

For this already-clean repository, the strict standalone gate preserves or
strengthens every guarantee supplied by empty identity baselines, the regression
count baseline, and baseline-freshness regeneration. Removing those artifacts
also removes the possibility of accepting a same-count debt swap or accidentally
updating a baseline to bless a finding.

The proof does not justify relying on Fallow defaults. The steady-state setup
must continue to preserve type-aware completeness, real Istanbul coverage,
semantic and near-duplicate analysis, health thresholds, architecture boundary
coverage, private-type-leak and stale-suppression errors, and entry-export
analysis.
