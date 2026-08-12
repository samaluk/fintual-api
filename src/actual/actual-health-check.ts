import { Context, Duration, Effect, Layer } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"

import { ActualConfigService } from "../env.ts"
import { ActualHealthCheckFailure } from "./actual-error.ts"

const HEALTH_CHECK_TIMEOUT = Duration.millis(10_000)

export class ActualHealthCheck extends Context.Service<
  ActualHealthCheck,
  {
    readonly check: Effect.Effect<void, ActualHealthCheckFailure>
  }
>()("ActualHealthCheck") {
  static readonly layer = Layer.effect(
    ActualHealthCheck,
    Effect.gen(function* () {
      const config = yield* ActualConfigService
      const client = yield* HttpClient.HttpClient

      const check = Effect.fn("ActualHealthCheck.check")(function* () {
        const healthUrl = getHealthUrl(config.serverUrl)
        const response = yield* client.execute(HttpClientRequest.get(healthUrl)).pipe(
          Effect.mapError(
            (cause) =>
              new ActualHealthCheckFailure({
                url: healthUrl,
                cause,
                retryable: true,
              }),
          ),
          Effect.timeoutOrElse({
            duration: HEALTH_CHECK_TIMEOUT,
            orElse: () =>
              Effect.fail(
                new ActualHealthCheckFailure({
                  url: healthUrl,
                  cause: new Error(
                    `health endpoint timed out after ${Duration.toMillis(HEALTH_CHECK_TIMEOUT)}ms`,
                  ),
                  retryable: true,
                }),
              ),
          }),
        )

        if (response.status >= 200 && response.status < 300) {
          return
        }

        return yield* new ActualHealthCheckFailure({
          url: healthUrl,
          status: response.status,
          cause: new Error(`health endpoint returned HTTP ${response.status}`),
          retryable: isRetryableStatus(response.status),
        })
      })

      return ActualHealthCheck.of({ check: check() })
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer))
}

function getHealthUrl(serverUrl: string): string {
  const normalizedBaseUrl = serverUrl.endsWith("/") ? serverUrl.slice(0, -1) : serverUrl
  return `${normalizedBaseUrl}/health`
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500
}
