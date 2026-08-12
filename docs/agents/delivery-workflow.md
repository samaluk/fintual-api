# Agent delivery workflow

Use this workflow for repository changes that will be committed or published.

## Establish the live scope

- Read the requested issue and its comments.
- Resolve every referenced issue or PR that could affect scope, sequencing, or
  ownership. Check its current state and purpose before presenting it as an open
  decision. Closed exploration notes are context, not implementation tickets,
  unless the user explicitly asks to reopen or supersede them.
- Check the current branch, remote default branch, working tree, and related PRs
  before editing. Start from current remote history rather than a stale detached
  commit.

## Plan reviewable commits before editing

For a multi-part change, write down the intended commit boundaries before the
first commit. Prefer coherent commits that each leave the repository usable.
"Land together" or "change atomically" does not imply one large commit.

Do not create a combined commit with the intention of splitting it later. If the
user changes the requested history after an unpublished commit exists, rewriting
that local history is acceptable, but it should be the exception.

## Keep diagnostic probes disposable

- Prefer read-only diagnostics.
- If a temporary code or configuration change is necessary, isolate it in a
  throwaway worktree or record the reverse patch before applying it.
- Restore the probe immediately after recording the result, then run the focused
  test or check affected by the probe.
- Inspect `git diff` before moving from diagnosis back to implementation.

Never preserve an awkward production or test-code shape solely to satisfy a
tool's evidence bound. Record the tool limitation and prefer a narrow tool
configuration or upstream fix.

## Use the hook verification boundary

- During development, run focused tests that directly support the change.
- Let pre-commit format and lint staged TypeScript.
- Let pre-push run the full format, lint, TypeScript, test, and Fallow gates once
  for the final branch.
- Run an individual full-project check outside the hooks only to diagnose a
  reported failure or when the user explicitly requests it.
- Do not rerun the full suite for every commit unless independently verified
  commits are an explicit requirement.

Use the repository's scoped formatting scripts. For files outside their scope,
make a minimal edit and preserve the existing layout; do not run a broad
formatter over unrelated configuration.

## Close the parent spec

A spec issue is a plan, not a backlog item. When the PR that closes the last
child ticket is published, the parent spec becomes complete:

- If this PR is the last open child, include `Closes #<spec>` alongside
  `Fixes #<child>` so merge closes both.
- If the spec has no child tickets, its own PR closes it normally.
- If the parent remains open after all children are closed through merged PRs,
  close it with a comment listing the child issues and PRs.
- If every child is closed without a merged PR, close the parent as
  `not_planned` (or `duplicate` when it duplicates another spec) with a comment
  rather than leaving a stale plan open.
- If some children landed and the rest were closed without landing, close the
  parent with a comment noting which work shipped and which was cancelled.

## Publish before resolving

An implementation issue is not complete when its change exists only in a local
commit. Push the branch and open the PR first. Prefer a closing keyword such as
`Fixes #123` in the PR body so merge closes the issue. Close an implementation
issue manually before merge only when the repository or user explicitly asks
for that workflow.

Before publishing, inspect the complete diff and stage only files in scope.
