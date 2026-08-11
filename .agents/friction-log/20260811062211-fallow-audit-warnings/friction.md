---
title: 'fallow audit warnings'
severity: 'minor'
issue: 'samaluk/fintual-api#328'
---

## Expected Behavior
The required Fallow audit should run without configuration-parser warnings.

## Current Behavior
The audit reports no issues but emits repeated warnings about invalid package dependency glob patterns.

## Possible Solution
Update the Fallow entry patterns to syntax accepted by its glob parser, or remove patterns that are no longer needed.

## Minimal Reproducible Example
Run `pnpm fallow:audit` from the repository root.

## Context
This appeared while validating issue #313. The audit passed, but the warnings add noise to a required check.
