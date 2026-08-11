/**
 * Interim compatibility surface for the Fintual Performance workflow until it
 * is wired directly to FintualProvider (issue #352 integration milestone).
 */
export {
  createGoalPerformanceRequest,
  parseGoalPerformanceResponseBody,
  TimeIntervalCode,
  type GoalPerformanceData,
} from "./provider.ts"
