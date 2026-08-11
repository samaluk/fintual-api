import { Effect, Fiber } from "effect"
import { expect, test } from "vitest"
import { FetchService } from "./authenticated-ingestion.ts"

test("aborts the underlying fetch when its request fiber is interrupted", async () => {
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

  const fiber = Effect.runFork(request)
  await requestStarted
  await Effect.runPromise(Fiber.interrupt(fiber))

  expect(observedSignal).toBeDefined()
  expect(observedSignal?.aborted).toBe(true)
})

test("fails with HttpTransportFailure when the request deadline aborts fetch", async () => {
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

  const fiber = Effect.runFork(request)
  await requestStarted

  await expect(Effect.runPromise(Fiber.join(fiber))).rejects.toMatchObject({
    _tag: "HttpTransportFailure",
    stage: "Fintual deadline",
  })
  expect(observedSignal?.aborted).toBe(true)
})
