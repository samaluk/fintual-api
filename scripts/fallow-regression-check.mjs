#!/usr/bin/env node
/**
 * Gate B: embedded regression baseline in .fallowrc.json.
 *
 * `fallow dead-code --fail-on-regression` still exits 1 when issues exist even if
 * the regression gate passes. Parse JSON and fail only on count regression.
 */
import { spawnSync } from "node:child_process";

const result = spawnSync(
	"pnpm",
	[
		"exec",
		"fallow",
		"dead-code",
		"--fail-on-regression",
		"--tolerance",
		"0",
		"--format",
		"json",
		"--quiet",
	],
	{ encoding: "utf8" },
);

if (result.error) {
	console.error(`fallow failed to start: ${result.error.message}`);
	process.exit(2);
}

const output = result.stdout?.trim();
if (!output) {
	console.error("Fallow regression check produced no JSON output.");
	if (result.stderr) {
		process.stderr.write(result.stderr);
	}
	process.exit(result.status ?? 2);
}

let report;
try {
	report = JSON.parse(output);
} catch {
	console.error("Fallow regression check returned invalid JSON.");
	process.stderr.write(output);
	process.exit(2);
}

const regression = report.regression;
if (!regression) {
	console.error("Fallow regression check JSON is missing `regression`.");
	process.exit(2);
}

if (regression.exceeded) {
	console.error(
		`Regression baseline exceeded: ${regression.current_total} issues (baseline ${regression.baseline_total}, delta +${regression.delta}).`,
	);
	process.exit(1);
}

if (regression.status !== "pass") {
	console.error(`Regression baseline check failed with status: ${regression.status}`);
	process.exit(1);
}

if (result.status !== 0 && result.status !== 1) {
	process.exit(result.status ?? 2);
}

console.log(
	`Regression baseline OK: ${regression.current_total} issues (baseline ${regression.baseline_total}).`,
);
