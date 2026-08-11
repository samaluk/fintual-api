import { Effect } from "effect"
import { main as mainActual } from "./actual.ts"
import { log } from "./effect.ts"
import type { RuntimeConfig } from "./env.ts"
import { runFintualSync } from "./fintual/http-sync.ts"

export function runJob(config: RuntimeConfig): Effect.Effect<void, Error> {
  return Effect.gen(function* () {
    yield* log("Running job...")
    const snapshot = yield* runFintualSync(config.fintual)
    yield* mainActual(config.actual, snapshot)
    yield* log("Job finished.")
  })
}
