---
title: 'Actual SDK auto-syncs every mutation under NODE_ENV=test'
severity: 'minor'
target: 'actualbudget/actual'
---

## Observed
In @actual-app/api 26.11.0, the SDK changes its sync behavior under NODE_ENV=test: it syncs inline after each mutation instead of scheduling a deferred sync. A loopback integration test can deadlock in a mutation when the server returns older CRDT messages while the mutation is still running. It also reports a transport failure during the mutation, not the explicit sync call.

## Workaround
Run the SDK with NODE_ENV=production inside the isolated integration-test worker to exercise the normal sync path; keep all budget data and the HTTP server local. Documenting this behavior in the SDK would help consumers write faithful integration tests.
