import { config } from "dotenv"

config()

export function getEnv(name: string, fallback = ""): string {
	const value = process.env[name]
	if (!value) {
		return fallback
	}

	return normalizeEnvValue(value)
}

export function normalizeEnvValue(value: string): string {
	const trimmedValue = value.trim()
	const startsWithQuote = trimmedValue.startsWith('"') || trimmedValue.startsWith("'")
	const endsWithQuote = trimmedValue.endsWith('"') || trimmedValue.endsWith("'")

	if (startsWithQuote && endsWithQuote && trimmedValue.length >= 2) {
		return trimmedValue.slice(1, -1).trim()
	}

	return trimmedValue
}
