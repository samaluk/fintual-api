/**
 * Prints `export VAR='...'` lines for capture script (single-quoted values).
 */
import { config } from "dotenv"
import { resolve } from "node:path"

function shSingleQuoted(value) {
	return "'" + value.replace(/'/g, "'\\''") + "'"
}

config({ path: resolve(process.cwd(), ".env"), quiet: true })
const keys = ["FINTUAL_USER_EMAIL", "FINTUAL_USER_PASSWORD", "FINTUAL_GOAL_ID"]
for (const k of keys) {
	const v = process.env[k]
	if (v != null && v !== "") process.stdout.write(`export ${k}=${shSingleQuoted(v)}\n`)
}
