import { pathToFileURL } from "node:url"
import { Effect } from "effect"
import { log } from "./effect.ts"
import { runJob } from "./job.ts"
import { getErrorMessage } from "./log.ts"
import "./env.ts"

const main: Effect.Effect<void, Error> = Effect.gen(function* () {
  yield* log("Running task once...")
  yield* runJob
  yield* log("Task completed.")
})

function isMainModule(): boolean {
  return import.meta.url === pathToFileURL(process.argv[1] ?? "").href
}

if (isMainModule()) {
  try {
    await Effect.runPromise(main)
    process.exit(0)
  } catch (error) {
    console.error(`Error running task: ${getErrorMessage(error)}`)
    process.exit(1)
  }
}
