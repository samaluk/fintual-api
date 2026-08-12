import * as fs from "node:fs"
import { Context, Effect, Layer } from "effect"
import { ActualDataDirectoryFailure } from "./actual-error.ts"

const ACTUAL_DATA_DIR = "./tmp/actual-data"

export class ActualFileSystem extends Context.Service<
  ActualFileSystem,
  {
    readonly reset: Effect.Effect<void, ActualDataDirectoryFailure>
  }
>()("ActualFileSystem") {
  static readonly live = Layer.succeed(
    ActualFileSystem,
    ActualFileSystem.of({
      reset: Effect.try({
        try: () => {
          fs.rmSync(ACTUAL_DATA_DIR, { recursive: true, force: true })
          fs.mkdirSync(ACTUAL_DATA_DIR, { recursive: true })
        },
        catch: (cause) => new ActualDataDirectoryFailure({ cause, retryable: false }),
      }).pipe(Effect.withSpan("ActualFileSystem.reset")),
    }),
  )
}
