import { normalizeEnvValue } from "./env"

const SENSITIVE_ENV_NAMES = [
	"ACTUAL_PASSWORD",
	"ACTUAL_SERVER_URL",
	"ACTUAL_SYNC_ID",
	"ACTUAL_FINTUAL_ACCOUNT",
	"ACTUAL_PAYEE",
	"FINTUAL_USER_EMAIL",
	"FINTUAL_USER_PASSWORD",
	"FINTUAL_GOAL_ID",
	"GMAIL_CLIENT_ID",
	"GMAIL_CLIENT_SECRET",
	"GMAIL_REFRESH_TOKEN",
	"GMAIL_USER_EMAIL",
	"FINTUAL_2FA_SENDER",
	"FINTUAL_2FA_SUBJECT",
] as const

export function getErrorMessage(error: unknown): string {
	if (error instanceof Error && error.message) {
		return redactSensitiveText(error.message)
	}

	if (typeof error === "string" && error.trim()) {
		return redactSensitiveText(error)
	}

	return "Unknown error"
}

function redactSensitiveText(value: string): string {
	let redactedValue = value

	for (const envName of SENSITIVE_ENV_NAMES) {
		const envValue = getNormalizedEnvValue(envName)
		if (!envValue) {
			continue
		}

		redactedValue = redactedValue.split(envValue).join(`[redacted ${envName}]`)
	}

	redactedValue = redactedValue.replaceAll(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted email]")

	return redactedValue
}

function getNormalizedEnvValue(name: string): string {
	const value = process.env[name]
	if (!value) {
		return ""
	}

	return normalizeEnvValue(value)
}
