import { Effect } from "effect"
import { toError } from "./log.ts"

export function tryPromise<A>(options: {
  try: () => Promise<A>
  catch: string | ((error: unknown) => string)
}): Effect.Effect<A, Error> {
  return Effect.tryPromise({
    try: options.try,
    catch: (error) => toError(error, options.catch),
  })
}

export function trySync<A>(options: {
  try: () => A
  catch: string | ((error: unknown) => string)
}): Effect.Effect<A, Error> {
  return Effect.try({
    try: options.try,
    catch: (error) => toError(error, options.catch),
  })
}

export function log(message: string): Effect.Effect<void> {
  return Effect.sync(() => console.log(message))
}

export function warn(message: string): Effect.Effect<void> {
  return Effect.sync(() => console.warn(message))
}

export function error(message: string): Effect.Effect<void> {
  return Effect.sync(() => console.error(message))
}

export function sleep(ms: number): Effect.Effect<void> {
  return Effect.sleep(`${ms} millis`)
}
