import type { Page } from "playwright"
import * as v from "valibot"
import { getErrorMessage } from "../log.ts"

export const TimeIntervalCode = {
	LastMonth: "last_month",
	LastSixMonths: "last_six_months",
	LastYear: "last_year",
	LastThreeYears: "last_three_years",
	AllTime: "all_time",
} as const

export type TimeIntervalCode = (typeof TimeIntervalCode)[keyof typeof TimeIntervalCode]

const NEW_PERFORMANCE_QUERY =
	"query GoalInvestedBalanceGraphDataPoints($goalId: ID!, $timeIntervalCode: String!) {\n  balanceGraphDataPoints: clGoalBalanceGraphDataPoints(\n    goalId: $goalId\n    timeIntervalCode: $timeIntervalCode\n  ) {\n    date\n    unrealizedCostBasisAmount\n    unrealizedGainOrLossAmount\n    realizedCostBasisAmount\n    realizedGainOrLossAmount\n    sharesCostBasisAmount\n    sharesValuationAmount\n    pendingFulfillmentReinvestmentDepositsCostBasisAmount\n    pendingFulfillmentReinvestmentDepositsAmount\n    withdrawnAmount\n    __typename\n  }\n}"

const newPerformanceSchema = v.object({
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

export type GoalPerformanceData = v.InferOutput<typeof newPerformanceSchema>["data"]

export async function getGoalPerformance(
	page: Page,
	goalId: string,
	timeIntervalCode: TimeIntervalCode,
): Promise<GoalPerformanceData | null> {
	const data = await page.evaluate(async ({ goalId, query, timeIntervalCode }) => {
		const response = await fetch("https://fintual.cl/gql/", {
			credentials: "include",
			headers: {
				Accept: "*/*",
				"content-type": "application/json",
			},
			body: JSON.stringify({
				operationName: "GoalInvestedBalanceGraphDataPoints",
				variables: {
					goalId,
					timeIntervalCode,
				},
				query,
			}),
			method: "POST",
		})

		return {
			ok: response.ok,
			status: response.status,
			body: await response.text(),
		}
	}, {
		goalId,
		query: NEW_PERFORMANCE_QUERY,
		timeIntervalCode,
	})

	if (!data.ok) {
		console.error(`Failed to fetch goal performance data (status ${data.status})`)
		return null
	}

	let parsedJson: unknown

	try {
		parsedJson = JSON.parse(data.body)
	} catch (error) {
		console.error(`Failed to parse goal performance response body: ${getErrorMessage(error)}`)
		return null
	}

	const parsedData = v.safeParse(newPerformanceSchema, parsedJson)
	if (!parsedData.success) {
		console.error("Failed to validate goal performance data")
		return null
	}

	return parsedData.output.data
}
