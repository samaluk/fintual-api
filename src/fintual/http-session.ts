import { Effect } from "effect"
import { tryPromise, trySync } from "../effect.ts"

const FINTUAL_ORIGIN = "https://fintual.cl"

/** Matches a typical desktop Chrome UA; some stacks behave differently without it. */
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

function mergeSetCookieHeaders(headers: Headers, jar: Map<string, string>): void {
  const lines = headers.getSetCookie?.() ?? []
  for (const line of lines) {
    const namePart = line.split(";", 1)[0]?.trim()
    if (!namePart?.includes("=")) {
      continue
    }
    const eq = namePart.indexOf("=")
    const name = namePart.slice(0, eq)
    jar.set(name, namePart)
  }
}

class FintualHttpSession {
  private readonly cookies = new Map<string, string>()

  /** Serialized `Cookie` header value for `fintual.cl` requests. */
  cookieHeader(): string {
    return [...this.cookies.values()].join("; ")
  }

  private commonBrowserHeaders(): Record<string, string> {
    return {
      "User-Agent": BROWSER_USER_AGENT,
      Origin: FINTUAL_ORIGIN,
    }
  }

  /**
   * Loads the sign-in page so any `Set-Cookie` (e.g. `_fintual_session_cookie`) is captured.
   * Mirrors the browser before `initiate_login` / `finalize_login_web`.
   */
  loadSignInPage(): Effect.Effect<void, Error> {
    return Effect.gen(this, function* () {
      const response = yield* tryPromise({
        try: () =>
          fetch(`${FINTUAL_ORIGIN}/f/sign-in/`, {
            redirect: "follow",
            headers: {
              Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
              ...this.commonBrowserHeaders(),
            },
          }),
        catch: "Failed to load Fintual sign-in page",
      })
      yield* trySync({
        try: () => mergeSetCookieHeaders(response.headers, this.cookies),
        catch: "Failed to merge Fintual sign-in cookies",
      })
      yield* tryPromise({
        try: () => response.arrayBuffer(),
        catch: "Failed to drain Fintual sign-in response",
      })
    })
  }

  /**
   * POST JSON `{ email, password }` to `/auth/sessions/initiate_login`.
   * Merges any `Set-Cookie` headers from the response into the jar.
   */
  initiateLogin(email: string, password: string): Effect.Effect<Response, Error> {
    const cookie = this.cookieHeader()
    return Effect.gen(this, function* () {
      const response = yield* tryPromise({
        try: () =>
          fetch(`${FINTUAL_ORIGIN}/auth/sessions/initiate_login`, {
            method: "POST",
            headers: {
              Accept: "application/json",
              "Content-Type": "application/json",
              Referer: `${FINTUAL_ORIGIN}/f/sign-in/`,
              ...this.commonBrowserHeaders(),
              ...(cookie ? { Cookie: cookie } : {}),
            },
            body: JSON.stringify({ email, password }),
          }),
        catch: "Failed to initiate Fintual login",
      })
      yield* trySync({
        try: () => mergeSetCookieHeaders(response.headers, this.cookies),
        catch: "Failed to merge Fintual initiate_login cookies",
      })
      return response
    })
  }

  /**
   * Completes web login after e-mail 2FA: POST `{ email, password, code }` to
   * `/auth/sessions/finalize_login_web` (same cookies as after `initiate_login`).
   */
  finalizeLoginWeb(email: string, password: string, code: string): Effect.Effect<Response, Error> {
    return Effect.gen(this, function* () {
      const response = yield* tryPromise({
        try: () =>
          fetch(`${FINTUAL_ORIGIN}/auth/sessions/finalize_login_web`, {
            method: "POST",
            headers: {
              Accept: "application/json",
              "Content-Type": "application/json",
              Referer: `${FINTUAL_ORIGIN}/f/sign-in/`,
              ...this.commonBrowserHeaders(),
              Cookie: this.cookieHeader(),
            },
            body: JSON.stringify({ email, password, code }),
          }),
        catch: "Failed to finalize Fintual login",
      })
      yield* trySync({
        try: () => mergeSetCookieHeaders(response.headers, this.cookies),
        catch: "Failed to merge Fintual finalize_login_web cookies",
      })
      return response
    })
  }

  /** POST a GraphQL body to `/gql/` using the current cookies. */
  postGql(payload: Record<string, unknown>): Effect.Effect<Response, Error> {
    return Effect.gen(this, function* () {
      const response = yield* tryPromise({
        try: () =>
          fetch(`${FINTUAL_ORIGIN}/gql/`, {
            method: "POST",
            headers: {
              Accept: "*/*",
              "Content-Type": "application/json",
              Referer: `${FINTUAL_ORIGIN}/`,
              ...this.commonBrowserHeaders(),
              Cookie: this.cookieHeader(),
            },
            body: JSON.stringify(payload),
          }),
        catch: "Failed to post Fintual GraphQL request",
      })
      yield* trySync({
        try: () => mergeSetCookieHeaders(response.headers, this.cookies),
        catch: "Failed to merge Fintual GraphQL cookies",
      })
      return response
    })
  }
}

export function createFintualHttpSession(): FintualHttpSession {
  return new FintualHttpSession()
}
