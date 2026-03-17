import { runJob } from "./job"
import { getErrorMessage } from "./log"
import "./env"

async function main(): Promise<void> {
	console.log("Running task once...")
	await runJob()
	console.log("Task completed.")
}

main().catch((error) => {
	console.error(`Error running task: ${getErrorMessage(error)}`)
	process.exit(1)
})
