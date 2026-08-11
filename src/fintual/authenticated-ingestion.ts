import { Context, Effect, Layer } from "effect"
import { getErrorMessage } from "../log.ts"
import { HttpTransportFailure, type FintualError } from "./fintual-error.ts"

export const FINTUAL_ORIGIN = "https://fintual.cl"
const HTTP_REQUEST_TIMEOUT_MS = 30_000
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

export class FetchService extends Context.Service<
  FetchService,
  {
    request: (
      path: string,
      init: RequestInit,
      stage: string,
    ) => Effect.Effect<Response, FintualError>
  }
>()("FetchService") {
  static readonly layer = (
    fetch: typeof globalThis.fetch,
    options: { readonly requestTimeoutMs?: number } = {},
  ) =>
    Layer.sync(FetchService, () => {
      const session = new FintualHttpSession(
        fetch,
        options.requestTimeoutMs ?? HTTP_REQUEST_TIMEOUT_MS,
      )
      return FetchService.of({
        request: (path, init, stage) => session.request(path, init, stage),
      })
    })
}

class FintualHttpSession {
  private readonly cookies = new Map<string, string>()
  private readonly fetchRequest: typeof globalThis.fetch
  private readonly requestTimeoutMs: number

  constructor(fetchRequest: typeof globalThis.fetch, requestTimeoutMs: number) {
    this.fetchRequest = fetchRequest
    this.requestTimeoutMs = requestTimeoutMs
  }

  readonly request = Effect.fn("FintualHttpSession.request")(
    { self: this },
    function* (
      this: FintualHttpSession,
      path: string,
      init: RequestInit,
      stage: string,
    ): Effect.fn.Return<Response, FintualError> {
      const headers = new Headers(init.headers)
      headers.set("User-Agent", BROWSER_USER_AGENT)
      headers.set("Origin", FINTUAL_ORIGIN)

      const cookieHeader = [...this.cookies.values()].join("; ")
      if (cookieHeader) {
        headers.set("Cookie", cookieHeader)
      }

      const response = yield* Effect.mapError(
        Effect.tryPromise({
          try: (signal) =>
            this.fetchRequest(`${FINTUAL_ORIGIN}${path}`, {
              ...init,
              headers,
              signal: AbortSignal.any([signal, AbortSignal.timeout(this.requestTimeoutMs)]),
            }),
          catch: (cause) =>
            new Error(`${stage}: request failed: ${getErrorMessage(cause)}`, { cause }),
        }),
        (cause) => new HttpTransportFailure({ stage, cause }),
      )

      yield* Effect.mapError(
        Effect.try({
          try: () => mergeSetCookieHeaders(response.headers, this.cookies),
          catch: (cause) =>
            new Error(`${stage}: failed to update session cookies: ${getErrorMessage(cause)}`, {
              cause,
            }),
        }),
        (cause) => new HttpTransportFailure({ stage, cause }),
      )

      return response
    },
  )
}

function mergeSetCookieHeaders(headers: Headers, jar: Map<string, string>): void {
  for (const line of headers.getSetCookie?.() ?? []) {
    const namePart = line.split(";", 1)[0]?.trim()
    if (!namePart?.includes("=")) {
      continue
    }

    const separatorIndex = namePart.indexOf("=")
    jar.set(namePart.slice(0, separatorIndex), namePart)
  }
}
