---
title: 'effect-solutions error guide uses an API absent from pinned Effect'
severity: 'minor'
---

## Expected Behavior

The effect-solutions error-handling guide should use APIs provided by the Effect version pinned in this repository.

## Current Behavior

The guide recommends Schema.TaggedErrorClass throughout, but effect 4.0.0-beta.106 exports Schema.TaggedError instead. Following the guide produces a TypeScript error and contradicts node_modules/effect/AGENTS.md and the installed source.

## Possible Solution

Generate or version the guide against the pinned Effect API, and replace Schema.TaggedErrorClass examples with Schema.TaggedError for this Effect release.

## Minimal Reproducible Example

Run effect-solutions show error-handling, copy its ValidationError example into this repository, and run pnpm typecheck.

## Context

Found while addressing the review of PR #345. The repository-local Effect skill contained the same stale identifier.
