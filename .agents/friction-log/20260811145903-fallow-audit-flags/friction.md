---
title: 'Fallow audit flags a public Environment type after Effect.fn refactoring'
severity: 'minor'
---

## Expected Behavior

The audit should recognize a public type that remains the parameter type of an exported function.

## Current Behavior

After resolveRuntimeConfig is converted to a named Effect.fn workflow, pnpm fallow:audit reports the exported Environment type as unused even though resolveRuntimeConfig still accepts it publicly.

## Possible Solution

Improve Fallow type-use analysis for function parameters wrapped by Effect.fn, or document the intentional test reference needed to preserve the public contract.

## Minimal Reproducible Example

Convert resolveRuntimeConfig from an exported function returning Effect.gen to an exported Effect.fn and run pnpm fallow:audit.

## Context

Observed while implementing issue 316 from origin/main at ce7800f.
