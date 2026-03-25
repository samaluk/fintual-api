import * as fs from "node:fs"
import type { Page } from "playwright"
import { chromium } from "playwright"
import { getEnv } from "../env.ts"
import { getErrorMessage } from "../log.ts"
import { login } from "./login.ts"
import { TimeIntervalCode, getGoalPerformance } from "./new-performance.ts"
import type { GoalPerformanceData } from "./new-performance.ts"

const BASE_URL = "https://fintual.cl"
const GOAL_ID = getEnv("FINTUAL_GOAL_ID")
const FINTUAL_DATA_DIR = "./tmp/fintual-data"
const BALANCE_FILE_PATH = `${FINTUAL_DATA_DIR}/balance-2.json`
const DEFAULT_PAGE_TIMEOUT_MS = 15000
const INITIAL_PAGE_LOAD_TIMEOUT_MS = 30000
const POST_LOGIN_WAIT_MS = 2000

export async function main(): Promise<void> {
	const browser = await chromium.launch({ headless: false })

	try {
		const context = await browser.newContext()
		const page = await context.newPage()
		page.setDefaultTimeout(DEFAULT_PAGE_TIMEOUT_MS)

		await page.setViewportSize({ width: 800, height: 600 })
		await page.goto(`${BASE_URL}/f/sign-in/`, { timeout: INITIAL_PAGE_LOAD_TIMEOUT_MS })

		const loginSucceeded = await login(page)
		if (!loginSucceeded) {
			throw new Error("Login failed")
		}

		await ensureAuthenticatedPage(page)
		await page.waitForTimeout(POST_LOGIN_WAIT_MS)

		const performanceData = await getPerformanceData(page)
		if (!performanceData) {
			console.error("Failed to get new performance data")
			return
		}

		writePerformanceFile(performanceData)
		console.log(`Balance data saved to ${BALANCE_FILE_PATH}`)
	} catch (error) {
		console.error(`Error: ${getErrorMessage(error)}`)
		process.exit(1)
	} finally {
		await browser.close()
	}
}

async function ensureAuthenticatedPage(page: Page): Promise<void> {
	await page.waitForLoadState("networkidle", { timeout: INITIAL_PAGE_LOAD_TIMEOUT_MS }).catch(() => undefined)

	const isStillOnLoginPage = page.url().includes("/f/sign-in")
	if (!isStillOnLoginPage) {
		return
	}

	const loginFormStillVisible = await page
		.locator('input[name="email"]')
		.first()
		.isVisible()
		.catch(() => false)
	if (loginFormStillVisible) {
		throw new Error("Login did not leave the sign-in page")
	}
}

async function getPerformanceData(page: Page): Promise<{ balance: unknown[]; deposits: unknown[] } | null> {
	const sixMonthData = await getGoalPerformance(page, GOAL_ID, TimeIntervalCode.LastSixMonths)
	const lastMonthData = await getGoalPerformance(page, GOAL_ID, TimeIntervalCode.LastMonth)

	if (!lastMonthData?.balanceGraphDataPoints || !sixMonthData?.balanceGraphDataPoints) {
		return null
	}

	const lastMonthPoints = lastMonthData.balanceGraphDataPoints
	const sixMonthPoints = sixMonthData.balanceGraphDataPoints
	const previousDeposits = getPreviousValue(sixMonthData, lastMonthData, (point) => point.unrealizedCostBasisAmount)
	const previousBalance = getPreviousValue(sixMonthData, lastMonthData, (point) => point.sharesValuationAmount)

	const deposits = lastMonthPoints.map((point, index, points) => {
		const previousValue = index === 0 ? previousDeposits : points[index - 1].unrealizedCostBasisAmount

		return {
			date: Date.parse(point.date),
			value: point.unrealizedCostBasisAmount,
			difference: point.unrealizedCostBasisAmount - previousValue,
		}
	})

	const balance = lastMonthPoints.map((point, index, points) => {
		const previousValue = index === 0 ? previousBalance : points[index - 1].sharesValuationAmount
		const previousDeposit = index === 0 ? previousDeposits : points[index - 1].unrealizedCostBasisAmount
		const deposit = point.unrealizedCostBasisAmount - previousDeposit
		const difference = point.sharesValuationAmount - previousValue - deposit

		return {
			date: Date.parse(point.date),
			value: point.sharesValuationAmount,
			difference,
			real_difference: difference,
		}
	})

	return { balance, deposits }
}

function getPreviousValue(
	baselineData: GoalPerformanceData,
	currentData: GoalPerformanceData,
	selectValue: (point: GoalPerformanceData["balanceGraphDataPoints"][number]) => number,
): number {
	const currentPoints = currentData.balanceGraphDataPoints
	const firstDate = currentPoints[0]?.date
	if (!firstDate) {
		return 0
	}

	const previousPoint = [...baselineData.balanceGraphDataPoints]
		.filter((point) => point.date < firstDate)
		.sort((left, right) => right.date.localeCompare(left.date))[0]

	if (previousPoint) {
		return selectValue(previousPoint)
	}

	return selectValue(currentPoints[0])
}

function writePerformanceFile(performanceData: { balance: unknown[]; deposits: unknown[] }): void {
	if (!fs.existsSync(FINTUAL_DATA_DIR)) {
		fs.mkdirSync(FINTUAL_DATA_DIR, { recursive: true })
	}

	fs.writeFileSync(BALANCE_FILE_PATH, JSON.stringify(performanceData, null, 2), "utf-8")
}
