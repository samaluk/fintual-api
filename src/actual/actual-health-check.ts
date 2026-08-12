import { Context, Effect, Layer } from "effect"

import { ActualHealthCheckFailure } from "./actual-error.ts"

const HEALTH_CHECK_TIMEOUT_MS = 10_000

export class ActualHealthCheck extends Context.Service<
  ActualHealthCheck,
  {
    readonly check: (serverUrl: string) => Effect.Effect<void, ActualHealthCheckFailure>
  }
>()("ActualHealthCheck") {
  static readonly layer = (fetchRequest: typeof globalThis.fetch) =>
    Layer.succeed(
      ActualHealthCheck,
      ActualHealthCheck.of({
        check: Effect.fn("ActualHealthCheck.check")(function* (serverUrl: string) {
          const healthUrl = getHealthUrl(serverUrl)
          const response = yield* Effect.tryPromise({
            try: (signal) =>
              fetchRequest(healthUrl, {
                method: "GET",
                signal,
              }),
            catch: (cause) =>
              new ActualHealthCheckFailure({
                url: healthUrl,
                cause,
                retryable: true,
              }),
          }).pipe(
            Effect.timeoutOrElse({
              duration: HEALTH_CHECK_TIMEOUT_MS,
              orElse: () =>
                Effect.fail(
                  new ActualHealthCheckFailure({
                    url: healthUrl,
                    cause: new Error(
                      `health endpoint timed out after ${HEALTH_CHECK_TIMEOUT_MS}ms`,
                    ),
                    retryable: true,
                  }),
                ),
            }),
          )

          if (response.ok) {
            return
          }

          return yield* new ActualHealthCheckFailure({
            url: healthUrl,
            status: response.status,
            cause: new Error(`health endpoint returned HTTP ${response.status}`),
            retryable: isRetryableStatus(response.status),
          })
        }),
      }),
    )
}

function getHealthUrl(serverUrl: string): string {
  const normalizedBaseUrl = serverUrl.endsWith("/") ? serverUrl.slice(0, -1) : serverUrl
  return `${normalizedBaseUrl}/health`
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500
}
