import { pathToFileURL } from "node:url"
import { runJob } from "./job.ts"
import { getErrorMessage } from "./log.ts"
import "./env.ts"

async function main(): Promise<void> {
	console.log("Running task once...")
	await runJob()
	console.log("Task completed.")
}

function isMainModule(): boolean {
	return import.meta.url === pathToFileURL(process.argv[1] ?? "").href
}

if (isMainModule()) {
	try {
		await main()
	} catch (error) {
		console.error(`Error running task: ${getErrorMessage(error)}`)
		process.exit(1)
	}
}
