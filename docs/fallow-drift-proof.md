# Fallow version-drift proof

This document records the local evidence for the version-keyed drift workflow
added in issue #432. The probes ran against Fallow 3.17.0 before the workflow
was merged into the default branch.

## Workflow checks

| Invariant | Evidence | Result |
|---|---|---|
| Workflow syntax | `actionlint .github/workflows/fallow-drift.yml` | Pass |
| Exact version resolution | The workflow's lockfile expression returned `3.17.0`; `pnpm exec fallow --version` returned `fallow 3.17.0` | Match |
| Fresh real coverage | `pnpm test:coverage` passed 11 files and 111 tests, then wrote `coverage/coverage-final.json` | Pass |
| Canonical gate | After asserting the coverage file existed, `pnpm fallow:ci` passed audit, dead-code, duplication, and coverage-aware health | Pass |
| Failure remains retryable | A disposable cache-control simulation failed the scan command before the marker step and found no version marker | Pass |
| Successful version becomes a no-op | The simulation saved the marker after success; a same-version rerun did not increment the scan count | Pass |

The failure and cache-hit probes mirrored the workflow's control flow in a
temporary directory. GitHub's cache action restores before the scan and saves a
new cache only in its post-job phase after a successful job. The workflow also
writes its marker after `pnpm fallow:ci`, so install, coverage, or Fallow
failures cannot produce the path that would be saved.

## Dispatch boundary

A manual dispatch cannot validate a new workflow before that workflow exists on
the default branch. The first post-merge dispatch or qualifying dependency push
therefore remains the integration check for GitHub's cache service. The local
checks cover the repository-owned mechanics; `actionlint` covers the workflow
schema and expressions.
