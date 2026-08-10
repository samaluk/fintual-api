import { pathToFileURL } from "node:url"
import { config as loadDotEnv } from "dotenv"
import { Effect } from "effect"
import { log } from "./effect.ts"
import { resolveRuntimeConfig } from "./env.ts"
import { runJob } from "./job.ts"
import { configureSensitiveValues, getErrorMessage } from "./log.ts"

loadDotEnv()

const main: Effect.Effect<void, Error> = Effect.gen(function* () {
  const runtimeConfig = yield* resolveRuntimeConfig(process.env)
  configureSensitiveValues(runtimeConfig)
  yield* log("Running task once...")
  yield* runJob(runtimeConfig)
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
