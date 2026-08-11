import { it } from "@effect/vitest"
import { Effect, Fiber } from "effect"
import { expect } from "vitest"
import { FetchService } from "./authenticated-ingestion.ts"

it.effect("aborts the underlying fetch when its request fiber is interrupted", () =>
  Effect.gen(function* () {
    let observedSignal: AbortSignal | undefined
    let resolveRequestStarted!: () => void
    const requestStarted = new Promise<void>((resolve) => {
      resolveRequestStarted = resolve
    })

    const fetch: typeof globalThis.fetch = async (_input, init = {}) => {
      observedSignal = init.signal ?? undefined
      resolveRequestStarted()

      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })
      })
    }

    const request = Effect.gen(function* () {
      const service = yield* FetchService
      yield* service.request("/slow", {}, "Fintual slow request")
    }).pipe(Effect.provide(FetchService.layer(fetch)))

    const fiber = yield* Effect.forkChild(request)
    yield* Effect.promise(() => requestStarted)
    yield* Fiber.interrupt(fiber)

    expect(observedSignal).toBeDefined()
    expect(observedSignal?.aborted).toBe(true)
  }),
)

it.effect("fails with HttpTransportFailure when the request deadline aborts fetch", () =>
  Effect.gen(function* () {
    let observedSignal: AbortSignal | undefined
    let resolveRequestStarted!: () => void
    const requestStarted = new Promise<void>((resolve) => {
      resolveRequestStarted = resolve
    })

    const fetch: typeof globalThis.fetch = async (_input, init = {}) => {
      observedSignal = init.signal ?? undefined
      resolveRequestStarted()

      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })
      })
    }

    const request = Effect.gen(function* () {
      const service = yield* FetchService
      yield* service.request("/slow", {}, "Fintual deadline")
    }).pipe(Effect.provide(FetchService.layer(fetch, { requestTimeoutMs: 0 })))

    const fiber = yield* Effect.forkChild(request)
    yield* Effect.promise(() => requestStarted)

    const error = yield* Effect.flip(Fiber.join(fiber))

    expect(error).toMatchObject({
      _tag: "HttpTransportFailure",
      stage: "Fintual deadline",
    })
    expect(observedSignal?.aborted).toBe(true)
  }),
)
