---
title: 'Actual CRDT 3.1.4 declaration imports do not resolve in NodeNext'
severity: 'minor'
target: 'actualbudget/actual'
---

## Observed
In a NodeNext TypeScript project, @actual-app/crdt 3.1.4 exports such as SyncRequestSchema and merkle lose type information. Its ESM declarations re-export extensionless relative paths (`./crdt` and `./proto/sync_pb`), which NodeNext cannot resolve even though the runtime bundle works.

## Workaround
Patch only the four affected .d.ts files so relative specifiers have `.js` extensions and `./crdt` points to `./crdt/index.js`. This preserves the actual SDK protocol and requires no lint or compiler suppression.
