#!/usr/bin/env node
/**
 * CI entrypoint for Fallow quality gates:
 * - Stale check: committed baselines must match a fresh regenerate
 * - Gate A: exact baselines (new finding identity)
 * - Gate B: embedded regression baseline (total issue count)
 *
 * PR audit (`fallow audit`) is available locally via `pnpm fallow:audit` but is not
 * run here: type-aware baselines currently fail audit identity checks (capabilities).
 * Full-repo Gates A + B enforce the ratchet in CI.
 */
import { spawnSync } from "node:child_process";

const FALLOW_VERSION = "3.14.0";

function run(command, args, { allowIssueExit = false } = {}) {
	const result = spawnSync(command, args, {
		stdio: "inherit",
		env: process.env,
	});

	if (result.error) {
		console.error(`${command} failed to start: ${result.error.message}`);
		process.exit(2);
	}

	if (result.status === 0) {
		return;
	}

	if (allowIssueExit && result.status === 1) {
		return;
	}

	process.exit(result.status ?? 2);
}

function fallow(args, options) {
	run("pnpm", ["exec", "fallow", ...args], options);
}

const version = spawnSync("pnpm", ["exec", "fallow", "--version"], {
	encoding: "utf8",
});

if (version.status !== 0) {
	console.error("Failed to read Fallow version.");
	process.exit(version.status ?? 2);
}

const versionMatch = version.stdout.match(/fallow\s+(\S+)/);
const installedVersion = versionMatch?.[1];
if (installedVersion !== FALLOW_VERSION) {
	console.error(`Expected fallow ${FALLOW_VERSION}, found ${installedVersion ?? "unknown"}.`);
	process.exit(2);
}

console.log(`==> Fallow ${installedVersion}`);
fallow(["type-aware", "status"]);

console.log("\n==> Baseline freshness");
run("node", ["scripts/fallow-baseline-check.mjs"]);

console.log("\n==> Gate A: exact baselines");
fallow(
	["dead-code", "--baseline", "fallow-baselines/dead-code.json", "--fail-on-issues", "--quiet"],
	{ allowIssueExit: false },
);
fallow(["dupes", "--baseline", "fallow-baselines/dupes.json", "--fail-on-issues", "--quiet"], {
	allowIssueExit: false,
});
fallow(
	[
		"health",
		"--baseline",
		"fallow-baselines/health.json",
		"--baseline-mode",
		"identity",
		"--fail-on-issues",
		"--quiet",
	],
	{ allowIssueExit: false },
);

console.log("\n==> Gate B: regression baseline (embedded in .fallowrc.json)");
run("node", ["scripts/fallow-regression-check.mjs"]);

console.log("\nFallow CI passed.");
