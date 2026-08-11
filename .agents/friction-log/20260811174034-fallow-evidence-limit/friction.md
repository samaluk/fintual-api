---
title: 'Fallow evidence limit makes valid member references fail complete analysis'
severity: 'minor'
target: 'fallow-rs/fallow'
---

## Expected Behavior

Type-aware Fallow analysis should remain complete when a class member has more
than one legitimate static reference, or expose a repository-configurable
evidence bound.

## Current Behavior

Fallow 3.14.0 can mark the whole analysis partial with gap reason
`evidence-limit` when a tagged error's `.message` member gains a second test
reference. Because this repository requires complete type-aware analysis, the
audit fails even though both references are valid.

## Possible Solution

Do not downgrade completeness merely because reference payloads are bounded, or
provide a configuration option that raises the evidence limit independently
from retained-reference proof.

## Minimal Reproducible Example

Add a second direct `.message` assertion for the same
`Schema.TaggedErrorClass` member and run `pnpm fallow:audit` with
`typeAware.require` set to `complete`.

## Context

Observed while implementing issue #343 with Fallow 3.14.0. The installed schema
exposes the completeness policy but no evidence-limit setting.
