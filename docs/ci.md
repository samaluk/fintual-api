# Continuous Integration (CI)

This document describes the repository's continuous integration design and records known benign tooling notices and warnings that appear in CI workflow runs.

## Job architecture

`.github/workflows/pr-check.yml` organizes checks into four jobs:

1. **`Lint, typecheck & format` (`static`)**: Runs Oxfmt, Oxlint, and TypeScript in parallel with testing.
2. **`Test with coverage` (`test`)**: Runs Vitest with V8 coverage in parallel with static checks, uploading `coverage/coverage-final.json` as an artifact.
3. **`Fallow gate` (`gate`)**: Runs `pnpm fallow:ci` using the test coverage artifact.
4. **`Fallow PR review` (`review`)**: Runs the authoritative changed-file Fallow audit and posts sticky PR review comments and Check Run annotations.

Running static checks and tests concurrently minimizes total CI wall-clock time (~50s).

## Known benign tooling notices and warnings

Automated CI log scanners and agents should treat the following log entries as expected, non-actionable tooling notices rather than repository bugs or regressions:

### 1. Parallel cache-save races

- **Log signature**:
  `##[warning]Failed to save: Unable to reserve cache with key pnpm-lockfile-verified-Linux-x64-..., another job may be creating this cache.`
- **Cause**: The `static` and `test` jobs run concurrently and both configure `pnpm/setup` with `cache: true`. When a pull request modifies `pnpm-lock.yaml` (e.g. dependency bumps) or after cache eviction, both jobs hit a cache miss and complete package installation at approximately the same time. Both jobs then attempt to reserve and save the new cache key in GitHub Actions. One job wins the reservation; the other logs this standard GitHub Actions cache lock warning.
- **Verdict**: **Benign / Expected**. GitHub Actions caches are immutable. The winning job successfully writes the cache, which is reused by downstream and future jobs. Serializing the parallel jobs to eliminate this warning would double CI duration without benefit.

### 2. Upstream Node runtime deprecation warnings

- **Log signatures**:
  - `(node:...) [DEP0176] DeprecationWarning: fs.R_OK is deprecated, use fs.constants.R_OK instead`
  - `(node:...) [DEP0190] DeprecationWarning: Passing args to a child process with shell option true can lead to security vulnerabilities, as the arguments are not escaped, only concatenated.`
- **Cause**: Node 24 is used in CI runners. Node 24 issues runtime deprecation notices for APIs used by third-party tooling:
  - `DEP0176` originates from `better-sqlite3`'s native build/install scripts during `pnpm install` (a transitive dependency of `@actual-app/api`).
  - `DEP0190` originates from actions runner cleanup or `pnpm` lifecycle hooks invoking subshells.
  Neither warning originates from application source code (`src/`).
- **Verdict**: **Benign / Expected**. These are upstream tooling notices that will resolve as upstream packages and actions publish Node 24 compatibility updates. Suppressing deprecations via `--no-deprecation` flags in CI is intentionally avoided so real deprecations in project code remain visible.
