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
	async loadSignInPage(): Promise<void> {
		const response = await fetch(`${FINTUAL_ORIGIN}/f/sign-in/`, {
			redirect: "follow",
			headers: {
				Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
				...this.commonBrowserHeaders(),
			},
		})
		mergeSetCookieHeaders(response.headers, this.cookies)
		await response.arrayBuffer()
	}

	/**
	 * POST JSON `{ email, password }` to `/auth/sessions/initiate_login`.
	 * Merges any `Set-Cookie` headers from the response into the jar.
	 */
	async initiateLogin(email: string, password: string): Promise<Response> {
		const cookie = this.cookieHeader()
		const response = await fetch(`${FINTUAL_ORIGIN}/auth/sessions/initiate_login`, {
			method: "POST",
			headers: {
				Accept: "application/json",
				"Content-Type": "application/json",
				Referer: `${FINTUAL_ORIGIN}/f/sign-in/`,
				...this.commonBrowserHeaders(),
				...(cookie ? { Cookie: cookie } : {}),
			},
			body: JSON.stringify({ email, password }),
		})
		mergeSetCookieHeaders(response.headers, this.cookies)
		return response
	}

	/**
	 * Completes web login after e-mail 2FA: POST `{ email, password, code }` to
	 * `/auth/sessions/finalize_login_web` (same cookies as after `initiate_login`).
	 */
	async finalizeLoginWeb(email: string, password: string, code: string): Promise<Response> {
		const response = await fetch(`${FINTUAL_ORIGIN}/auth/sessions/finalize_login_web`, {
			method: "POST",
			headers: {
				Accept: "application/json",
				"Content-Type": "application/json",
				Referer: `${FINTUAL_ORIGIN}/f/sign-in/`,
				...this.commonBrowserHeaders(),
				Cookie: this.cookieHeader(),
			},
			body: JSON.stringify({ email, password, code }),
		})
		mergeSetCookieHeaders(response.headers, this.cookies)
		return response
	}

	/** POST a GraphQL body to `/gql/` using the current cookies. */
	async postGql(payload: Record<string, unknown>): Promise<Response> {
		const response = await fetch(`${FINTUAL_ORIGIN}/gql/`, {
			method: "POST",
			headers: {
				Accept: "*/*",
				"Content-Type": "application/json",
				Referer: `${FINTUAL_ORIGIN}/`,
				...this.commonBrowserHeaders(),
				Cookie: this.cookieHeader(),
			},
			body: JSON.stringify(payload),
		})
		mergeSetCookieHeaders(response.headers, this.cookies)
		return response
	}
}

export function createFintualHttpSession(): FintualHttpSession {
	return new FintualHttpSession()
}
