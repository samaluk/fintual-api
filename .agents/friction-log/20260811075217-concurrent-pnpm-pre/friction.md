---
title: 'Concurrent pnpm pre-push checks race over node_modules binaries'
severity: 'minor'
---

## Expected Behavior

Running the repository pre-push verification should execute the configured checks without transient dependency-install warnings.

## Current Behavior

The pre-push hook runs several checks concurrently. During the dependency transition between the wire-only and snapshot stack layers, pnpm emitted warnings that it could not create `node_modules/.bin/fallow` and `node_modules/.bin/tsgolint` because those paths briefly did not exist. The checks recovered and all passed.

## Possible Solution

Avoid concurrent pnpm lifecycle installs in hook jobs, or isolate each check from shared node_modules mutations before running the checks.

## Minimal Reproducible Example

1. Push a stack branch whose manifest changes the Valibot dependency set.
2. Observe the pre-push hook start multiple pnpm commands in parallel.
3. Observe transient `Failed to create bin` warnings while pnpm removes and recreates dependency links.
4. Observe the checks finish successfully after the links settle.

## Context

Observed while pushing the Effect Schema wire migration branch for issue #314 on 2026-08-11. This is repository tooling friction only; no source or test failure resulted.
