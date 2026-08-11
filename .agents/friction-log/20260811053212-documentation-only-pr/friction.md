---
title: 'Documentation-only PR accidentally closed an unimplemented architecture issue'
severity: 'major'
issue: 'samaluk/fintual-api#319'
---

## Expected Behavior

An architecture implementation issue remains open until its implementation acceptance criteria are delivered.

## Current Behavior

PR #290 changed only `CONTEXT.md` but included `Closes #286`, marking the Actual Effect-native implementation issue completed. Subsequent issue #298 explicitly treated #286 as already implemented and preserved the behavior #286 was meant to replace. The issue had to be reopened after an Effect audit.

## Possible Solution

Require implementation acceptance evidence before using closing keywords, or separate decision/documentation issues from implementation issues so a documentation PR cannot silently complete build work.

## Minimal Reproducible Example

1. Open #286, which requests an Effect-native Actual synchronization implementation.
2. Merge documentation-only PR #290 containing `Closes #286`.
3. Observe #286 marked completed although `src/actual.ts` remains unchanged.
4. Observe #298 treating #286 as completed and declaring typed failures and retry redesign out of scope.

## Context

Discovered while persisting the idiomatic Effect audit follow-ups on 2026-08-11. #286 has been reopened and linked into the new dependency graph.
