import { main as mainActual } from "./actual"
import { main as mainScraper } from "./fintual/scraper"
import "./env"

export async function runJob(): Promise<void> {
	console.log("Running job...")
	await mainScraper()
	await mainActual()
	console.log("Job finished.")
}
