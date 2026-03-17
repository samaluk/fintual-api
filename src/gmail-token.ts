import { spawn } from "node:child_process"
import { constants as fsConstants } from "node:fs"
import { access, readFile, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { join } from "node:path"
import { cwd, platform } from "node:process"
import { google } from "googleapis"
import { getEnv } from "./env"
import { getErrorMessage } from "./log"

const GMAIL_CLIENT_ID = getEnv("GMAIL_CLIENT_ID")
const GMAIL_CLIENT_SECRET = getEnv("GMAIL_CLIENT_SECRET")
const GMAIL_USER_EMAIL = getEnv("GMAIL_USER_EMAIL")
const GMAIL_OAUTH_REDIRECT_URI = getEnv("GMAIL_OAUTH_REDIRECT_URI", "http://127.0.0.1:3000/oauth2/callback")
const GMAIL_OAUTH_BIND_HOST = getEnv("GMAIL_OAUTH_BIND_HOST")
const GMAIL_OAUTH_OPEN_BROWSER = getEnv("GMAIL_OAUTH_OPEN_BROWSER", "true")
const OAUTH_CALLBACK_TIMEOUT_MS = 120000
const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly"

interface AuthorizationCodeOptions {
	redirectUri: URL
	authUrl: string
	timeoutMs: number
}

interface OpenCommand {
	command: string
	args: string[]
}

async function main(): Promise<void> {
	if (!GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET) {
		throw new Error("Missing GMAIL_CLIENT_ID or GMAIL_CLIENT_SECRET in .env")
	}

	const envPath = join(cwd(), ".env")
	const hasEnvFile = await fileExists(envPath)

	const redirectUri = validateRedirectUri(GMAIL_OAUTH_REDIRECT_URI)
	const oauthClient = new google.auth.OAuth2(GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, redirectUri.toString())
	const authorizationUrl = oauthClient.generateAuthUrl({
		access_type: "offline",
		prompt: "consent",
		include_granted_scopes: true,
		scope: [GMAIL_READONLY_SCOPE],
	})

	printAuthorizationInstructions(redirectUri, authorizationUrl)

	const authorizationCode = await waitForAuthorizationCode({
		redirectUri,
		authUrl: authorizationUrl,
		timeoutMs: OAUTH_CALLBACK_TIMEOUT_MS,
	})
	const { tokens } = await oauthClient.getToken(authorizationCode)
	const refreshToken = tokens.refresh_token ?? ""

	if (!refreshToken) {
		throw new Error("No refresh token returned. Re-run with prompt=consent and revoke previous app consent if needed.")
	}

	const envUpdates = buildEnvUpdates(refreshToken, redirectUri)
	if (hasEnvFile) {
		await updateEnvFile(envPath, envUpdates)
		console.log(`Updated ${envPath} with Gmail OAuth credentials.`)
	} else {
		printRefreshTokenInstructions(refreshToken)
	}

	console.log("Gmail refresh token generated successfully.")
}

function buildEnvUpdates(refreshToken: string, redirectUri: URL): Record<string, string> {
	return {
		GMAIL_CLIENT_ID,
		GMAIL_CLIENT_SECRET,
		GMAIL_REFRESH_TOKEN: refreshToken,
		...(GMAIL_USER_EMAIL ? { GMAIL_USER_EMAIL } : {}),
		GMAIL_OAUTH_REDIRECT_URI: redirectUri.toString(),
	}
}

function printAuthorizationInstructions(redirectUri: URL, authorizationUrl: string): void {
	console.log("\nStarting local OAuth callback listener...\n")
	console.log(`Redirect URI: ${redirectUri.toString()}`)
	console.log("If the browser does not open automatically, open this URL manually:\n")
	console.log(authorizationUrl)
	console.log("")
}

function printRefreshTokenInstructions(refreshToken: string): void {
	console.log("No .env file found in the current container, so the refresh token was not written to disk.")
	console.log("Save this value in your secret manager as GMAIL_REFRESH_TOKEN:\n")
	console.log(refreshToken)
	console.log("")
}

function validateRedirectUri(value: string): URL {
	const redirectUri = new URL(value)

	if (redirectUri.protocol !== "http:") {
		throw new Error("GMAIL_OAUTH_REDIRECT_URI must use http:// for the local callback flow")
	}

	if (!redirectUri.hostname) {
		throw new Error("GMAIL_OAUTH_REDIRECT_URI must include a hostname")
	}

	if (!redirectUri.port) {
		throw new Error("GMAIL_OAUTH_REDIRECT_URI must include an explicit port")
	}

	return redirectUri
}

async function waitForAuthorizationCode(options: AuthorizationCodeOptions): Promise<string> {
	const { redirectUri, authUrl, timeoutMs } = options

	return await new Promise<string>((resolve, reject) => {
		const server = createServer((request, response) => {
			const requestUrl = getRequestUrl(request.url, redirectUri)
			if (!requestUrl) {
				response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" })
				response.end("Missing request URL.")
				return
			}

			if (requestUrl.pathname !== redirectUri.pathname) {
				response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" })
				response.end("Not found.")
				return
			}

			const oauthError = requestUrl.searchParams.get("error")
			if (oauthError) {
				response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" })
				response.end(`Google OAuth returned an error: ${oauthError}`)
				clearTimeout(timeout)
				server.close()
				reject(new Error(`Google OAuth returned an error: ${oauthError}`))
				return
			}

			const authorizationCode = requestUrl.searchParams.get("code")
			if (!authorizationCode) {
				response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" })
				response.end("Authorization code missing from callback.")
				clearTimeout(timeout)
				server.close()
				reject(new Error("Authorization code missing from OAuth callback"))
				return
			}

			response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
			response.end("<h1>Authorization complete</h1><p>You can close this window and return to the terminal.</p>")
			clearTimeout(timeout)
			server.close()
			resolve(authorizationCode)
		})

		const timeout = setTimeout(() => {
			server.close()
			reject(new Error(`Timed out waiting for OAuth callback after ${Math.round(timeoutMs / 1000)} seconds`))
		}, timeoutMs)

		server.once("error", (error) => {
			clearTimeout(timeout)
			reject(error)
		})

		server.listen(Number.parseInt(redirectUri.port, 10), getOauthBindHost(redirectUri), () => {
			void openBrowser(authUrl)
		})
	})
}

function getOauthBindHost(redirectUri: URL): string {
	if (GMAIL_OAUTH_BIND_HOST) {
		return GMAIL_OAUTH_BIND_HOST
	}

	return redirectUri.hostname
}

function getRequestUrl(requestUrl: string | undefined, redirectUri: URL): URL | null {
	if (!requestUrl) {
		return null
	}

	return new URL(requestUrl, redirectUri)
}

async function openBrowser(url: string): Promise<void> {
	if (!shouldOpenBrowser()) {
		return
	}

	const openCommand = getOpenCommand(url)
	if (!openCommand) {
		return
	}

	try {
		await new Promise<void>((resolve, reject) => {
			const child = spawn(openCommand.command, openCommand.args, {
				stdio: "ignore",
				detached: true,
			})

			child.once("error", reject)
			child.once("spawn", () => {
				child.unref()
				resolve()
			})
		})
	} catch (error) {
		console.warn(`Unable to open the browser automatically: ${getErrorMessage(error)}`)
	}
}

function shouldOpenBrowser(): boolean {
	return GMAIL_OAUTH_OPEN_BROWSER !== "false"
}

function getOpenCommand(url: string): OpenCommand | null {
	if (platform === "darwin") {
		return { command: "open", args: [url] }
	}

	if (platform === "win32") {
		return { command: "cmd", args: ["/c", "start", "", url] }
	}

	if (platform === "linux") {
		return { command: "xdg-open", args: [url] }
	}

	return null
}

async function fileExists(path: string): Promise<boolean> {
	try {
		await access(path, fsConstants.F_OK)
		return true
	} catch {
		return false
	}
}

async function updateEnvFile(path: string, updates: Record<string, string>): Promise<void> {
	const current = await readFile(path, "utf8")
	const lines = current.split(/\r?\n/)
	const remainingUpdates = new Map(Object.entries(updates))
	const nextLines = lines.map((line) => {
		for (const [key, value] of remainingUpdates) {
			if (line.startsWith(`${key}=`)) {
				remainingUpdates.delete(key)
				return `${key}=${value}`
			}
		}

		return line
	})

	if (nextLines.length > 0 && nextLines.at(-1) !== "") {
		nextLines.push("")
	}

	for (const [key, value] of remainingUpdates) {
		nextLines.push(`${key}=${value}`)
	}

	const normalized = nextLines.join("\n").replaceAll(/\n+$/g, "\n")
	await writeFile(path, normalized, "utf8")
}

main().catch((error) => {
	console.error(`Failed to generate Gmail refresh token: ${getErrorMessage(error)}`)
	process.exit(1)
})
