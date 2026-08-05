#!/usr/bin/env node
/**
 * Regenerate baselines into a temp workspace and fail when committed files differ.
 * Exact baselines live in fallow-baselines/*.json; regression counts live in .fallowrc.json.
 *
 * Comparisons use canonical JSON so trailing newlines / key formatting from Fallow
 * do not create false staleness.
 */
import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EXACT_BASELINE_FILES = [
	"fallow-baselines/dead-code.json",
	"fallow-baselines/dupes.json",
	"fallow-baselines/health.json",
];

function runFallow(args, { allowIssueExit = false } = {}) {
	const result = spawnSync("pnpm", ["exec", "fallow", ...args, "--quiet"], {
		stdio: "inherit",
		env: process.env,
	});

	if (result.error) {
		console.error(`fallow failed to start: ${result.error.message}`);
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

function canonicalJson(text) {
	return JSON.stringify(JSON.parse(text));
}

const tempRoot = mkdtempSync(join(tmpdir(), "fallow-baseline-check-"));
const tempConfigPath = join(tempRoot, ".fallowrc.json");

try {
	copyFileSync(".fallowrc.json", tempConfigPath);

	for (const file of EXACT_BASELINE_FILES) {
		const generatedPath = join(tempRoot, file);
		mkdirSync(join(tempRoot, "fallow-baselines"), { recursive: true });

		if (file.endsWith("health.json")) {
			runFallow(
				[
					"-c",
					tempConfigPath,
					"health",
					"--save-baseline",
					generatedPath,
					"--baseline-mode",
					"identity",
				],
				{ allowIssueExit: true },
			);
			continue;
		}

		const command = file.includes("dead-code") ? "dead-code" : "dupes";
		runFallow(
			["-c", tempConfigPath, command, "--save-baseline", generatedPath],
			{ allowIssueExit: true },
		);
	}

	runFallow(["-c", tempConfigPath, "dead-code", "--save-regression-baseline"], {
		allowIssueExit: true,
	});

	const stale = [];

	for (const file of EXACT_BASELINE_FILES) {
		const committed = canonicalJson(readFileSync(file, "utf8"));
		const generated = canonicalJson(readFileSync(join(tempRoot, file), "utf8"));

		if (committed !== generated) {
			stale.push(file);
		}
	}

	const committedRegression = JSON.stringify(
		JSON.parse(readFileSync(".fallowrc.json", "utf8")).regression ?? null,
	);
	const generatedRegression = JSON.stringify(
		JSON.parse(readFileSync(tempConfigPath, "utf8")).regression ?? null,
	);

	if (committedRegression !== generatedRegression) {
		stale.push(".fallowrc.json (regression.baseline)");
	}

	if (stale.length > 0) {
		console.error(
			"\nCommitted Fallow baselines are stale. Run `pnpm fallow:baseline:update` and commit the results:",
		);
		for (const file of stale) {
			console.error(`  - ${file}`);
		}
		process.exit(1);
	}

	console.log("Fallow baselines match the current repository state.");
} finally {
	rmSync(tempRoot, { recursive: true, force: true });
}
