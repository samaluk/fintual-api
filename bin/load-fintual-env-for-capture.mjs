/**
 * Prints `export VAR='...'` lines for capture script (single-quoted values).
 */
import { NodeFileSystem } from "@effect/platform-node"
import { ConfigProvider, Effect } from "effect"

function shSingleQuoted(value) {
	return "'" + value.replace(/'/g, "'\\''") + "'"
}

const dotEnv = ConfigProvider.fromDotEnv().pipe(
	Effect.provide(NodeFileSystem.layer),
	Effect.orElseSucceed(() => ConfigProvider.fromUnknown({})),
)

const exportKey = (provider, key) =>
	Effect.gen(function* () {
		const node = yield* provider.load([key])
		if (node?.value) {
			process.stdout.write(`export ${key}=${shSingleQuoted(node.value)}\n`)
		}
	})

const program = Effect.gen(function* () {
	const provider = ConfigProvider.orElse(ConfigProvider.fromEnv(), yield* dotEnv)
	yield* Effect.forEach(["FINTUAL_USER_EMAIL", "FINTUAL_USER_PASSWORD", "FINTUAL_GOAL_ID"], (key) =>
		exportKey(provider, key),
	)
})

Effect.runPromise(program)
