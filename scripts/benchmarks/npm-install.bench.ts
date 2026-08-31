import { AgentOs } from "@rivet-dev/agentos-core";
import { allowAll } from "@rivet-dev/agentos-core/internal/runtime-compat";

const HONO_VERSION = "4.13.5";
const DEFAULT_RUNS = 3;

function parseRuns(argv: string[]): number {
	const index = argv.indexOf("--runs");
	if (index === -1) return DEFAULT_RUNS;
	const runs = Number.parseInt(argv[index + 1] ?? "", 10);
	if (!Number.isSafeInteger(runs) || runs < 1) {
		throw new Error("--runs must be a positive integer");
	}
	return runs;
}

function usesWarmCache(argv: string[]): boolean {
	return argv.includes("--warm-cache");
}

function median(samples: number[]): number {
	const sorted = [...samples].sort((left, right) => left - right);
	return sorted[Math.floor(sorted.length / 2)];
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const runs = parseRuns(argv);
	const warmCache = usesWarmCache(argv);
	const sidecar = await AgentOs.createSidecar();
	const samples: number[] = [];

	try {
		for (let run = 1; run <= runs; run += 1) {
			const vm = await AgentOs.create({
				defaultSoftware: false,
				software: [],
				permissions: allowAll,
				sidecar: { kind: "explicit", handle: sidecar },
			});
			try {
				const projectDir = "/workspace/npm-hono";
				const cacheDir = "/tmp/npm-hono-cache";
				await vm.mkdir(projectDir, { recursive: true });
				await vm.writeFile(
					`${projectDir}/package.json`,
					JSON.stringify({ name: "npm-hono-benchmark", private: true }),
				);
				if (warmCache) {
					const cacheResult = await vm.execArgv(
						"npm",
						[
							"cache",
							"add",
							`hono@${HONO_VERSION}`,
							"--ignore-scripts",
							"--no-audit",
							"--no-fund",
							"--loglevel=error",
						],
						{ env: { npm_config_cache: cacheDir } },
					);
					if (cacheResult.exitCode !== 0) {
						throw new Error(
							`npm cache add failed on run ${run}: ${cacheResult.stderr || cacheResult.stdout}`,
						);
					}
				}

				const startedAt = performance.now();
				const result = await vm.execArgv(
					"npm",
					[
						"install",
						`hono@${HONO_VERSION}`,
						"--save-exact",
						"--ignore-scripts",
						"--no-audit",
						"--no-fund",
						"--loglevel=error",
					],
					{
						cwd: projectDir,
						env: { npm_config_cache: cacheDir },
					},
				);
				const durationMs = Math.round(performance.now() - startedAt);
				if (result.exitCode !== 0) {
					throw new Error(
						`npm install failed on run ${run}: ${result.stderr || result.stdout}`,
					);
				}
				samples.push(durationMs);
				console.log(JSON.stringify({ run, durationMs }));
			} finally {
				await vm.dispose();
			}
		}
	} finally {
		await sidecar.dispose();
	}

	console.log(
		JSON.stringify({
			benchmark: "fresh-npm-install-hono",
			honoVersion: HONO_VERSION,
			cacheState: warmCache ? "prefetched" : "empty",
			runs,
			samplesMs: samples,
			medianMs: median(samples),
		}),
	);
}

await main();
