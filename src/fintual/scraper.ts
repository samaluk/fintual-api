import "../env"
import { getRandom } from "random-useragent"
import { chromium } from "playwright"
import * as fs from "node:fs"
import { login } from "./login"
import type { BrowserFields } from "./new-performance"
import { TimeIntervalCode, getGoalPerformance } from "./new-performance"

const BASE_URL = "https://fintual.cl"

const GOAL_ID = process.env.FINTUAL_GOAL_ID ?? ""

export async function main() {
	try {
		const USER_AGENT = getRandom()

		const browser = await chromium.launch({ headless: true })
		const context = await browser.newContext({ userAgent: USER_AGENT })
		const page = await context.newPage()
		page.setDefaultTimeout(5000)
		await page.setViewportSize({ width: 800, height: 600 })
		await page.goto(`${BASE_URL}/f/sign-in/`, { timeout: 30000 })

		const success = await login(page)
		if (!success) {
			throw new Error("Login failed")
		}

		await page.waitForTimeout(2000)

		// Get cookies and browser fields
		const cookies = await context.cookies()
		const cookieString = cookies.map((c) => `${c.name}=${c.value}`).join("; ")
		const sentryTrace = await page.evaluate(
			() => document.querySelector('meta[name="sentry-trace"]')?.getAttribute("content") || "",
		)
		const baggage = await page.evaluate(
			() => document.querySelector('meta[name="baggage"]')?.getAttribute("content") || "",
		)
		const browserFields = {
			cookie: cookieString,
			sentryTrace,
			baggage,
			userAgent: USER_AGENT,
			referrer: page.url(),
		} satisfies BrowserFields

		// Fetch last_six_months for previous value, but only output last_month data
		const sixMonthData = await getGoalPerformance(GOAL_ID, TimeIntervalCode.LastSixMonths, browserFields)
		const lastMonthData = await getGoalPerformance(GOAL_ID, TimeIntervalCode.LastMonth, browserFields)
		if (!lastMonthData?.balanceGraphDataPoints || !sixMonthData?.balanceGraphDataPoints) {
			console.error("Failed to get new performance data")
			await browser.close()
			return
		}

		// Find the previous value for the first entry in last_month
		const lastMonthPoints = lastMonthData.balanceGraphDataPoints
		const sixMonthPoints = sixMonthData.balanceGraphDataPoints
		// Find the entry in sixMonthPoints just before the first lastMonthPoints date
		const firstDate = lastMonthPoints[0]?.date
		let previousDeposits = 0
		if (firstDate) {
			const prev = sixMonthPoints.filter((d) => d.date < firstDate).sort((a, b) => b.date.localeCompare(a.date))[0]
			if (prev) previousDeposits = prev.unrealizedCostBasisAmount
			else previousDeposits = lastMonthPoints[0].unrealizedCostBasisAmount // fallback
		}

		const depositsArr = lastMonthPoints.map((d, i, arr) => {
			const prevValue = i === 0 ? previousDeposits : arr[i - 1].unrealizedCostBasisAmount
			return {
				date: Date.parse(d.date),
				value: d.unrealizedCostBasisAmount,
				difference: d.unrealizedCostBasisAmount - prevValue,
			}
		})

		// Update balanceArr logic similarly
		// For balance, use sharesValuationAmount as the value
		let previousBalance = 0
		if (firstDate) {
			const prevBal = sixMonthPoints.filter((d) => d.date < firstDate).sort((a, b) => b.date.localeCompare(a.date))[0]
			if (prevBal) previousBalance = prevBal.sharesValuationAmount
			else previousBalance = lastMonthPoints[0].sharesValuationAmount // fallback
		}

		const balanceArr = lastMonthPoints.map((d, i, arr) => {
			const prevValue = i === 0 ? previousBalance : arr[i - 1].sharesValuationAmount
			const realPrevValue = i === 0 ? previousBalance : arr[i - 1].sharesValuationAmount
			// Deposit for this day is the change in unrealizedCostBasisAmount
			const prevDeposit = i === 0 ? previousDeposits : arr[i - 1].unrealizedCostBasisAmount
			const deposit = d.unrealizedCostBasisAmount - prevDeposit
			const diff = d.sharesValuationAmount - prevValue - deposit
			const realDiff = d.sharesValuationAmount - realPrevValue - deposit
			return {
				date: Date.parse(d.date),
				value: d.sharesValuationAmount,
				difference: diff,
				real_difference: realDiff,
			}
		})

		const perf = {
			balance: balanceArr,
			deposits: depositsArr,
		}

		// Save the balance data to a file
		if (!fs.existsSync("./tmp/fintual-data")) {
			fs.mkdirSync("./tmp/fintual-data", { recursive: true })
		}
		fs.writeFileSync("./tmp/fintual-data/balance-2.json", JSON.stringify(perf, null, 2), "utf-8")
		console.log("Balance data saved to tmp/fintual-data/balance-2.json")

		await browser.close()
	} catch (error) {
		console.error("Error:", error)
		process.exit(1)
	}
}
