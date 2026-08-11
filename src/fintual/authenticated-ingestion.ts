import { Context, Effect, Layer } from "effect"
import { tryPromise, trySync } from "../effect.ts"
import { HttpTransportFailure, type FintualError } from "./fintual-error.ts"

export const FINTUAL_ORIGIN = "https://fintual.cl"
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
  static readonly layer = (fetch: typeof globalThis.fetch) =>
    Layer.sync(FetchService, () => {
      const session = new FintualHttpSession(fetch)
      return FetchService.of({
        request: (path, init, stage) => session.request(path, init, stage),
      })
    })
}

class FintualHttpSession {
  private readonly cookies = new Map<string, string>()
  private readonly fetchRequest: typeof globalThis.fetch

  constructor(fetchRequest: typeof globalThis.fetch) {
    this.fetchRequest = fetchRequest
  }

  request(path: string, init: RequestInit, stage: string): Effect.Effect<Response, FintualError> {
    return Effect.gen({ self: this }, function* () {
      const headers = new Headers(init.headers)
      headers.set("User-Agent", BROWSER_USER_AGENT)
      headers.set("Origin", FINTUAL_ORIGIN)

      const cookieHeader = [...this.cookies.values()].join("; ")
      if (cookieHeader) {
        headers.set("Cookie", cookieHeader)
      }

      const response = yield* Effect.mapError(
        tryPromise({
          try: () => this.fetchRequest(`${FINTUAL_ORIGIN}${path}`, { ...init, headers }),
          catch: `${stage}: request failed`,
        }),
        (cause) => new HttpTransportFailure({ stage, cause }),
      )

      yield* Effect.mapError(
        trySync({
          try: () => mergeSetCookieHeaders(response.headers, this.cookies),
          catch: `${stage}: failed to update session cookies`,
        }),
        (cause) => new HttpTransportFailure({ stage, cause }),
      )

      return response
    })
  }
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
