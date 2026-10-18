---
title: 'Fallow trace calls a type unused while public-signature analysis retains it'
severity: 'minor'
target: 'fallow-rs/fallow'
---

## Expected Behavior

Tracing an exported type retained by a public function signature should explain why the findings pipeline preserves it, or clearly distinguish direct import references from signature-based retention.

## Current Behavior

With Fallow 3.33.1, `dead-code --unused-types --fail-on-issues` accepts an exported Environment type used by an exported Effect.fn function's parameter without any test import. The same fixture's `dead-code --trace src/env.ts:Environment` emits `is_used: false`, an empty direct_references list, and `reason: "No references found, export is unused"`. That explanation contradicts the unused-types finding verdict.

## Possible Solution

Include public-signature retention in trace evidence, or describe this state as retained by a public signature rather than declaring the export unused. Do not add incidental test references or production workarounds to satisfy the diagnostic.

## Minimal Reproducible Example

Use effect 4.0.5 and fallow 3.33.1 in a two-module project with `.fallowrc.json` containing `{"entry":["src/main.ts"],"includeEntryExports":true}`.

`src/env.ts`:

```ts
import { Effect } from "effect"
export type Environment = Readonly<Record<string, string | undefined>>
export const resolveRuntimeConfig = Effect.fn("RuntimeConfig.resolveRuntimeConfig")(
  function* (environment: Environment) {
    return environment.VALUE
  }
)
```

`src/main.ts`:

```ts
import { Effect } from "effect"
import { resolveRuntimeConfig } from "./env.ts"
console.log(Effect.runSync(resolveRuntimeConfig({ VALUE: "ok" })))
```

1. Run `fallow dead-code --unused-types --no-type-aware --no-cache --fail-on-issues --format json --quiet`: unused_types is empty and exit status is 0.
2. Run `fallow dead-code --trace src/env.ts:Environment --no-type-aware --no-cache --format json --quiet`: the trace declares Environment unused.
3. Add `export type UnusedControl = string` to env.ts. The first command now reports exactly UnusedControl and exits 1, confirming that unused-type detection was active; Environment remains accepted.

## Context

Found while revalidating samaluk/fintual-api#337. The original gate false positive is resolved with the pinned analyzer; this diagnostic inconsistency made it necessary to use a positive control and inspect findings rather than relying on trace alone. The disposable fixture was removed after the probe.
