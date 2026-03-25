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

function parseGoalPerformanceJsonText(body: string): GoalPerformanceData | null {
	let parsedJson: unknown

	try {
		parsedJson = JSON.parse(body)
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

const GQL_URL = "https://fintual.cl/gql/"

/** GraphQL fetch using a raw `Cookie` header (see `docs/fintual-http-capture.md`). */
export async function getGoalPerformanceWithCookies(
	cookieHeader: string,
	goalId: string,
	timeIntervalCode: TimeIntervalCode,
): Promise<GoalPerformanceData | null> {
	const response = await fetch(GQL_URL, {
		method: "POST",
		headers: {
			Accept: "*/*",
			"content-type": "application/json",
			Referer: "https://fintual.cl/",
			...(cookieHeader ? { Cookie: cookieHeader } : {}),
		},
		body: JSON.stringify({
			operationName: "GoalInvestedBalanceGraphDataPoints",
			variables: {
				goalId,
				timeIntervalCode,
			},
			query: NEW_PERFORMANCE_QUERY,
		}),
	})

	const body = await response.text()

	if (!response.ok) {
		console.error(`Failed to fetch goal performance data (status ${response.status})`)
		return null
	}

	return parseGoalPerformanceJsonText(body)
}
