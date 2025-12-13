import type { BrowserContext, Page } from "playwright"
import { chromium } from "playwright"
import { getRandom } from "random-useragent"
import * as v from "valibot"
import { login } from "./login"

const BASE_URL = "https://fintual.cl"

export enum TimeIntervalCode {
	LastMonth = "last_month",            // Daily
	LastSixMonths = "last_six_months",   // Daily
	LastYear = "last_year",              // Daily
	LastThreeYears = "last_three_years", // Weekly
	AllTime = "all_time",                // Monthly
}

export interface BrowserFields {
	cookie: string
	sentryTrace: string
	baggage: string
	userAgent: string
	referrer: string
}

export const newPerformanceSchema = v.object({
  data: v.object({
    balanceGraphDataPoints: v.array(
      v.object({
        date: v.pipe(v.string(), v.isoDate()),
        unrealizedCostBasisAmount: v.number(),
        unrealizedGainOrLossAmount: v.number(),
        realizedCostBasisAmount: v.number(),
        realizedGainOrLossAmount: v.number(),
        sharesCostBasisAmount: v.number(),
        sharesValuationAmount: v.number(),
        pendingFulfillmentReinvestmentDepositsCostBasisAmount: v.number(),
        pendingFulfillmentReinvestmentDepositsAmount: v.number(),
        withdrawnAmount: v.number(),
      }),
    ),
  }),
})

export async function getGoalPerformance(
	goalId: string,
	timeIntervalCode: TimeIntervalCode,
	browserFields: BrowserFields,
) {
	const response = await fetch("https://fintual.cl/gql/", {
		credentials: "include",
		headers: {
			"User-Agent": browserFields.userAgent,
			Accept: "*/*",
			"Accept-Language": "en-US,en;q=0.5",
			"content-type": "application/json",
			cookie: browserFields.cookie,
			"sentry-trace": browserFields.sentryTrace,
			baggage: browserFields.baggage,
			"Sec-GPC": "1",
			"Alt-Used": "fintual.cl",
			"Sec-Fetch-Dest": "empty",
			"Sec-Fetch-Mode": "cors",
			"Sec-Fetch-Site": "same-origin",
			Priority: "u=0",
		},
		referrer: browserFields.referrer,
		body: JSON.stringify({
			operationName: "GoalInvestedBalanceGraphDataPoints",
			variables: {
				goalId,
				timeIntervalCode,
			},
			query:
				"query GoalInvestedBalanceGraphDataPoints($goalId: ID!, $timeIntervalCode: String!) {\n  balanceGraphDataPoints: clGoalBalanceGraphDataPoints(\n    goalId: $goalId\n    timeIntervalCode: $timeIntervalCode\n  ) {\n    date\n    unrealizedCostBasisAmount\n    unrealizedGainOrLossAmount\n    realizedCostBasisAmount\n    realizedGainOrLossAmount\n    sharesCostBasisAmount\n    sharesValuationAmount\n    pendingFulfillmentReinvestmentDepositsCostBasisAmount\n    pendingFulfillmentReinvestmentDepositsAmount\n    withdrawnAmount\n    __typename\n  }\n}",
		}),
		method: "POST",
		mode: "cors",
	})

	if (!response.ok) {
		console.error("Failed to fetch goal performance data", await response.text())
		return null
	}

	const data = await response.json()
	const parsed = v.safeParse(newPerformanceSchema, data)
	if (!parsed.success) {
		console.error("Failed to parse goal performance data", parsed.issues)
		return null
	}
	return parsed.output.data
}

export async function queryFintual(context: BrowserContext, userAgent: string, page: Page) {
	const cookies = await context.cookies()
	const cookieString = cookies.map((c) => `${c.name}=${c.value}`).join("; ")

	const sentryTrace = await page.evaluate(
		() => document.querySelector('meta[name="sentry-trace"]')?.getAttribute("content") || "",
	)
	const baggage = await page.evaluate(
		() => document.querySelector('meta[name="baggage"]')?.getAttribute("content") || "",
	)

	const browserFields: BrowserFields = {
		cookie: cookieString,
		sentryTrace,
		baggage,
		userAgent: userAgent,
		referrer: page.url(),
	}

	return await getGoalPerformance("318803", TimeIntervalCode.LastMonth, browserFields)
}

async function main() {
	const USER_AGENT = getRandom()

	const browser = await chromium.launch({ headless: false })
	const context = await browser.newContext({ userAgent: USER_AGENT })
	const page = await context.newPage()
	page.setDefaultTimeout(5000)
	await page.setViewportSize({ width: 800, height: 600 })
	await page.goto(`${BASE_URL}/f/sign-in/`, { timeout: 30000 })

	const success = await login(page)
	if (!success) {
		console.error("Login failed")
		// throw new Error("Login failed")
	}

	await page.waitForTimeout(2000)
	const data = await queryFintual(context, USER_AGENT, page)
	console.dir(data, { depth: null })

	await browser.close()
}
