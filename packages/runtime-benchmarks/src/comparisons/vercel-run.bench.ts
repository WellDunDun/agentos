/**
 * End-to-end comparison of Vercel Run and the public agentOS JavaScript API.
 *
 * The lanes are deliberately named by lifecycle. Vercel Run creates a fresh
 * QuickJS context for every invocation. agentOS supports both a fresh
 * execution and an explicitly retained V8 context. The Node control is not a
 * security boundary; it only helps separate engine work from runtime overhead.
 */

import { execFileSync, spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

type AgentOsInstance = Awaited<
	ReturnType<typeof import("@rivet-dev/agentos").AgentOs.create>
>;
type RunFunction = typeof import("run").run;

const WARMUP_ITERATIONS = envInteger("BENCH_WARMUP", 5);
const ITERATIONS = envInteger("BENCH_ITERATIONS", 30);
const HEAVY_ITERATIONS = envInteger("BENCH_HEAVY_ITERATIONS", 12);
const COLD_ITERATIONS = envInteger("BENCH_COLD_ITERATIONS", 7);
const CONCURRENCY_ITERATIONS = envInteger("BENCH_CONCURRENCY_ITERATIONS", 8);
const TIMEOUT_MS = envInteger("BENCH_EXEC_TIMEOUT_MS", 30_000);
const SCRIPT_PATH = fileURLToPath(import.meta.url);

type Lane =
	| "node-v8-control"
	| "vercel-run-fresh"
	| "agentos-fresh"
	| "agentos-retained";

interface Scenario {
	id: string;
	description: string;
	runSource: string;
	agentExpression: string;
	expected: unknown;
	iterations?: number;
}

interface SampleStats {
	samples: number;
	mean: number;
	p50: number;
	p95: number;
	p99: number;
	min: number;
	max: number;
}

interface LaneResult {
	stats: SampleStats;
	rawSamplesMs: number[];
}

interface ChildResult {
	mode: string;
	[key: string]: unknown;
}

const arithmeticExpression = `(() => {
  let x = 0x12345678;
  for (let i = 0; i < 1_000_000; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
  }
  return x >>> 0;
})()`;

const arrayExpression = `(() => {
  const values = new Array(100_000);
  for (let i = 0; i < values.length; i++) values[i] = (i * 17) & 0xffff;
  values.sort((a, b) => a - b);
  let checksum = 0;
  for (let i = 0; i < values.length; i += 97) checksum = (checksum + values[i]) >>> 0;
  return checksum;
})()`;

const jsonExpression = `(() => {
  const rows = [];
  for (let i = 0; i < 5_000; i++) rows.push({ id: i, name: "row-" + i, active: (i & 1) === 0 });
  const encoded = JSON.stringify(rows);
  const decoded = JSON.parse(encoded);
  return decoded.length + decoded[4_999].id;
})()`;

const regexExpression = `(() => {
  const text = "alpha-123 beta-456 gamma-789 ".repeat(10_000);
  const matches = text.match(/[a-z]+-(?:456|789)/g);
  return matches.length;
})()`;

const paddedSource = `${"/* benchmark source padding */\n".repeat(4_200)}return 42;`;
const paddedExpression = `${"/* benchmark source padding */\n".repeat(4_200)}42`;

const scenarios: Scenario[] = [
	{
		id: "noop",
		description: "End-to-end invocation and scalar result",
		runSource: "return 42;",
		agentExpression: "42",
		expected: 42,
	},
	{
		id: "source-128k",
		description: "Parse/transfer a roughly 128 KiB source body",
		runSource: paddedSource,
		agentExpression: paddedExpression,
		expected: 42,
	},
	{
		id: "result-64k",
		description: "Serialize and return a 64 KiB string",
		runSource: 'return "x".repeat(65_536);',
		agentExpression: '"x".repeat(65_536)',
		expected: "x".repeat(65_536),
	},
	{
		id: "integer-loop-1m",
		description: "One million xorshift iterations",
		runSource: `return ${arithmeticExpression};`,
		agentExpression: arithmeticExpression,
		expected: 868636661,
		iterations: HEAVY_ITERATIONS,
	},
	{
		id: "array-sort-100k",
		description: "Allocate, sort, and checksum 100k numbers",
		runSource: `return ${arrayExpression};`,
		agentExpression: arrayExpression,
		expected: 33680841,
		iterations: HEAVY_ITERATIONS,
	},
	{
		id: "json-roundtrip-5k",
		description: "Build, stringify, and parse 5k objects",
		runSource: `return ${jsonExpression};`,
		agentExpression: jsonExpression,
		expected: 9999,
		iterations: HEAVY_ITERATIONS,
	},
	{
		id: "regex-scan-300k",
		description: "Regex scan over roughly 300 KiB of text",
		runSource: `return ${regexExpression};`,
		agentExpression: regexExpression,
		expected: 20_000,
		iterations: HEAVY_ITERATIONS,
	},
];

function envInteger(name: string, fallback: number): number {
	const parsed = Number(process.env[name]);
	return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function round(value: number, decimals = 2): number {
	const factor = 10 ** decimals;
	return Math.round(value * factor) / factor;
}

function percentile(sorted: number[], value: number): number {
	const index = Math.ceil((value / 100) * sorted.length) - 1;
	return sorted[Math.max(0, index)];
}

function stats(samples: number[]): SampleStats {
	const sorted = [...samples].sort((left, right) => left - right);
	return {
		samples: samples.length,
		mean: round(
			samples.reduce((total, value) => total + value, 0) / samples.length,
		),
		p50: round(percentile(sorted, 50)),
		p95: round(percentile(sorted, 95)),
		p99: round(percentile(sorted, 99)),
		min: round(sorted[0]),
		max: round(sorted.at(-1) ?? Number.NaN),
	};
}

function getHardware(): Record<string, unknown> {
	const cpu = os.cpus()[0]?.model ?? "unknown";
	return {
		cpu,
		cores: os.availableParallelism(),
		ram: `${round(os.totalmem() / 1024 ** 3, 1)} GB`,
		node: process.version,
		os: `${os.type()} ${os.release()}`,
		arch: os.arch(),
		loadAverage: os.loadavg().map((value) => round(value, 2)),
	};
}

function jsonEqual(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function assertExpected(id: string, actual: unknown, expected: unknown): void {
	if (!jsonEqual(actual, expected)) {
		throw new Error(
			`${id} returned ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`,
		);
	}
}

async function time<T>(operation: () => Promise<T> | T): Promise<[number, T]> {
	const startedAt = performance.now();
	const value = await operation();
	return [performance.now() - startedAt, value];
}

function laneResult(samples: number[]): LaneResult {
	return {
		stats: stats(samples),
		rawSamplesMs: samples.map((sample) => round(sample, 4)),
	};
}

async function runScenarioSamples(
	scenario: Scenario,
	lane: Lane,
	operation: () => Promise<unknown> | unknown,
): Promise<LaneResult> {
	const iterations = scenario.iterations ?? ITERATIONS;
	const samples: number[] = [];
	for (let index = 0; index < WARMUP_ITERATIONS + iterations; index++) {
		const [durationMs, value] = await time(operation);
		assertExpected(`${scenario.id}/${lane}`, value, scenario.expected);
		if (index >= WARMUP_ITERATIONS) samples.push(durationMs);
	}
	return laneResult(samples);
}

async function evaluateAgentOs(
	runtime: AgentOsInstance,
	expression: string,
	contextId?: string,
): Promise<unknown> {
	const result = await runtime.javascript.evaluate(expression, {
		contextId,
		timeoutMs: TIMEOUT_MS,
	});
	if (result.outcome !== "succeeded") {
		throw new Error(
			`agentOS execution failed: ${result.error.message}\n${result.stderr ?? ""}`,
		);
	}
	return result.value;
}

async function evaluateRun(run: RunFunction, source: string): Promise<unknown> {
	const result = await run({ source, limits: { timeoutMs: TIMEOUT_MS } });
	if (result.status !== "completed") {
		throw new Error(`Vercel Run unexpectedly interrupted (${result.status})`);
	}
	return result.value;
}

function evaluateNode(expression: string): unknown {
	return vm.runInNewContext(expression, Object.create(null), {
		timeout: TIMEOUT_MS,
	});
}

async function measureCoreScenarios(
	run: RunFunction,
	runtime: AgentOsInstance,
): Promise<
	Array<{
		id: string;
		description: string;
		iterations: number;
		results: Record<Lane, LaneResult>;
	}>
> {
	const results = [];
	for (const scenario of scenarios) {
		console.error(`Measuring ${scenario.id}...`);
		const lanes = {} as Record<Lane, LaneResult>;
		lanes["node-v8-control"] = await runScenarioSamples(
			scenario,
			"node-v8-control",
			() => evaluateNode(scenario.agentExpression),
		);
		lanes["vercel-run-fresh"] = await runScenarioSamples(
			scenario,
			"vercel-run-fresh",
			() => evaluateRun(run, scenario.runSource),
		);
		lanes["agentos-fresh"] = await runScenarioSamples(
			scenario,
			"agentos-fresh",
			() => evaluateAgentOs(runtime, scenario.agentExpression),
		);
		lanes["agentos-retained"] = await runScenarioSamples(
			scenario,
			"agentos-retained",
			() =>
				evaluateAgentOs(runtime, scenario.agentExpression, "retained-bench"),
		);
		results.push({
			id: scenario.id,
			description: scenario.description,
			iterations: scenario.iterations ?? ITERATIONS,
			results: lanes,
		});
	}
	return results;
}

interface ToolScenario {
	id: string;
	description: string;
	runSource: string;
	agentExpression: string;
	expected: unknown;
	hostFunctions: Record<string, Record<string, (...args: never[]) => unknown>>;
	iterations?: number;
}

async function measureToolScenarios(
	run: RunFunction,
	runtime: AgentOsInstance,
): Promise<
	Array<
		Omit<ToolScenario, "hostFunctions" | "runSource" | "agentExpression"> & {
			results: Record<Exclude<Lane, "node-v8-control">, LaneResult>;
		}
	>
> {
	const payload = "p".repeat(32 * 1024);
	const scenarios: ToolScenario[] = [
		{
			id: "host-call-single",
			description: "One synchronous host echo call with a small payload",
			runSource: 'return (await tools.echo("hello")).value;',
			agentExpression: `(async () => {
  const { execFileSync } = await import("node:child_process");
  return JSON.parse(execFileSync("agentos-tools", ["echo", "--value", "hello"], { encoding: "utf8" })).result.value;
})()`,
			expected: "hello",
			hostFunctions: {
				tools: { echo: ((value: string) => ({ value })) as never },
			},
		},
		{
			id: "host-call-10x",
			description: "Ten sequential synchronous host echo calls",
			runSource:
				'let value; for (let i = 0; i < 10; i++) value = (await tools.echo("hello")).value; return value;',
			agentExpression: `(async () => {
  const { execFileSync } = await import("node:child_process");
  let value;
  for (let i = 0; i < 10; i++) value = JSON.parse(execFileSync("agentos-tools", ["echo", "--value", "hello"], { encoding: "utf8" })).result.value;
  return value;
})()`,
			expected: "hello",
			hostFunctions: {
				tools: { echo: ((value: string) => ({ value })) as never },
			},
			iterations: Math.min(ITERATIONS, 15),
		},
		{
			id: "host-call-32k-roundtrip",
			description: "One host echo call carrying 32 KiB in each direction",
			runSource: `return (await tools.echo(${JSON.stringify(payload)})).value;`,
			agentExpression: `(async () => {
  const { execFileSync } = await import("node:child_process");
  return JSON.parse(execFileSync("agentos-tools", ["echo", "--value", ${JSON.stringify(payload)}], { encoding: "utf8" })).result.value;
})()`,
			expected: payload,
			hostFunctions: {
				tools: { echo: ((value: string) => ({ value })) as never },
			},
			iterations: Math.min(ITERATIONS, 15),
		},
		{
			id: "host-call-async-5ms",
			description: "One async host call whose implementation waits 5 ms",
			runSource: "return await tools.wait();",
			agentExpression: `(async () => {
  const { execFileSync } = await import("node:child_process");
  return JSON.parse(execFileSync("agentos-tools", ["wait"], { encoding: "utf8" })).result;
})()`,
			expected: 42,
			hostFunctions: {
				tools: {
					wait: (async () => {
						await new Promise((resolve) => setTimeout(resolve, 5));
						return 42;
					}) as never,
				},
			},
			iterations: Math.min(ITERATIONS, 15),
		},
	];

	const output = [];
	for (const scenario of scenarios) {
		console.error(`Measuring ${scenario.id}...`);
		const iterations = scenario.iterations ?? ITERATIONS;
		const measure = async (
			lane: Exclude<Lane, "node-v8-control">,
			operation: () => Promise<unknown>,
		): Promise<LaneResult> => {
			const samples: number[] = [];
			for (let index = 0; index < WARMUP_ITERATIONS + iterations; index++) {
				const [durationMs, value] = await time(operation);
				assertExpected(`${scenario.id}/${lane}`, value, scenario.expected);
				if (index >= WARMUP_ITERATIONS) samples.push(durationMs);
			}
			return laneResult(samples);
		};
		const runResult = await measure("vercel-run-fresh", async () => {
			const result = await run({
				source: scenario.runSource,
				hostFunctions: scenario.hostFunctions,
				limits: { timeoutMs: TIMEOUT_MS },
			});
			if (result.status !== "completed") throw new Error(result.status);
			return result.value;
		});
		const freshResult = await measure("agentos-fresh", () =>
			evaluateAgentOs(runtime, scenario.agentExpression),
		);
		const retainedResult = await measure("agentos-retained", () =>
			evaluateAgentOs(runtime, scenario.agentExpression, "retained-bench"),
		);
		output.push({
			id: scenario.id,
			description: scenario.description,
			expected:
				typeof scenario.expected === "string" && scenario.expected.length > 100
					? `<string:${scenario.expected.length}>`
					: scenario.expected,
			iterations,
			results: {
				"vercel-run-fresh": runResult,
				"agentos-fresh": freshResult,
				"agentos-retained": retainedResult,
			},
		});
	}
	return output;
}

async function measureConcurrency(
	run: RunFunction,
	runtime: AgentOsInstance,
): Promise<unknown[]> {
	const source = `return ${arithmeticExpression.replace("1_000_000", "200_000")};`;
	const expression = arithmeticExpression.replace("1_000_000", "200_000");
	const rows = [];
	for (const concurrency of [1, 4, 8]) {
		for (const [lane, operation] of [
			["vercel-run-fresh", () => evaluateRun(run, source)],
			["agentos-fresh", () => evaluateAgentOs(runtime, expression)],
		] as const) {
			const batchSamples: number[] = [];
			const operationSamples: number[] = [];
			for (
				let iteration = 0;
				iteration < WARMUP_ITERATIONS + CONCURRENCY_ITERATIONS;
				iteration++
			) {
				const startedAt = performance.now();
				const values = await Promise.all(
					Array.from({ length: concurrency }, async () => {
						const [durationMs, value] = await time(operation);
						return { durationMs, value };
					}),
				);
				for (const value of values) {
					assertExpected(
						`${lane}/concurrency-${concurrency}`,
						value.value,
						2044719859,
					);
				}
				if (iteration >= WARMUP_ITERATIONS) {
					batchSamples.push(performance.now() - startedAt);
					operationSamples.push(...values.map((value) => value.durationMs));
				}
			}
			const batch = laneResult(batchSamples);
			rows.push({
				lane,
				concurrency,
				batch,
				operationLatency: laneResult(operationSamples),
				throughputOpsPerSecond: round((concurrency / batch.stats.mean) * 1_000),
			});
		}
	}
	return rows;
}

function childArgs(mode: string): string[] {
	return ["--expose-gc", "--import", "tsx", SCRIPT_PATH, "--child", mode];
}

async function runChild(mode: string): Promise<ChildResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, childArgs(mode), {
			cwd: fileURLToPath(new URL("../..", import.meta.url)),
			stdio: ["ignore", "pipe", "inherit"],
		});
		let stdout = "";
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.on("error", reject);
		child.on("exit", (code) => {
			if (code !== 0) {
				reject(new Error(`child ${mode} exited ${code}`));
				return;
			}
			try {
				resolve(JSON.parse(stdout) as ChildResult);
			} catch (error) {
				reject(
					new Error(`invalid child ${mode} output: ${stdout}`, {
						cause: error,
					}),
				);
			}
		});
	});
}

async function collectColdStart(): Promise<Record<string, LaneResult>> {
	const output: Record<string, LaneResult> = {};
	for (const mode of ["cold-run", "cold-agentos"]) {
		const samples: number[] = [];
		for (let index = 0; index < COLD_ITERATIONS; index++) {
			const result = await runChild(mode);
			samples.push(Number(result.totalMs));
		}
		output[mode] = laneResult(samples);
	}
	return output;
}

function processTreeRssBytes(rootPid = process.pid): number {
	const records = new Map<number, { parentPid: number; rssBytes: number }>();
	for (const entry of readdirSync("/proc")) {
		if (!/^\d+$/.test(entry)) continue;
		try {
			const status = readFileSync(`/proc/${entry}/status`, "utf8");
			const parentPid = Number(/^PPid:\s+(\d+)/m.exec(status)?.[1] ?? -1);
			const rssKb = Number(/^VmRSS:\s+(\d+)\s+kB/m.exec(status)?.[1] ?? 0);
			records.set(Number(entry), { parentPid, rssBytes: rssKb * 1024 });
		} catch {
			// Process exited while /proc was being inspected.
		}
	}
	const descendants = new Set([rootPid]);
	let changed = true;
	while (changed) {
		changed = false;
		for (const [pid, record] of records) {
			if (!descendants.has(pid) && descendants.has(record.parentPid)) {
				descendants.add(pid);
				changed = true;
			}
		}
	}
	return [...descendants].reduce(
		(total, pid) => total + (records.get(pid)?.rssBytes ?? 0),
		0,
	);
}

async function settleMemory(): Promise<void> {
	global.gc?.();
	await new Promise((resolve) => setTimeout(resolve, 30));
}

async function childMain(mode: string): Promise<void> {
	const baselineRssBytes = processTreeRssBytes();
	if (mode === "cold-run") {
		const { run } = await import("run");
		const [totalMs, value] = await time(() => evaluateRun(run, "return 42;"));
		assertExpected(mode, value, 42);
		console.log(JSON.stringify({ mode, totalMs }));
		return;
	}
	if (mode === "cold-agentos") {
		const { AgentOs } = await import("@rivet-dev/agentos");
		const startedAt = performance.now();
		const runtime = await AgentOs.create({ defaultSoftware: false });
		const createMs = performance.now() - startedAt;
		try {
			const [firstExecuteMs, value] = await time(() =>
				evaluateAgentOs(runtime, "42"),
			);
			assertExpected(mode, value, 42);
			console.log(
				JSON.stringify({
					mode,
					createMs,
					firstExecuteMs,
					totalMs: createMs + firstExecuteMs,
				}),
			);
		} finally {
			await runtime.dispose();
		}
		return;
	}
	if (mode === "memory-run") {
		const { run } = await import("run");
		await settleMemory();
		const importedRssBytes = processTreeRssBytes();
		for (let index = 0; index < 10; index++)
			await evaluateRun(run, "return 42;");
		await settleMemory();
		console.log(
			JSON.stringify({
				mode,
				baselineRssBytes,
				importedRssBytes,
				warmRssBytes: processTreeRssBytes(),
			}),
		);
		return;
	}
	if (mode === "memory-agentos") {
		const { AgentOs } = await import("@rivet-dev/agentos");
		await settleMemory();
		const importedRssBytes = processTreeRssBytes();
		const runtime = await AgentOs.create({ defaultSoftware: false });
		try {
			for (let index = 0; index < 10; index++) {
				await evaluateAgentOs(runtime, "42");
			}
			await settleMemory();
			console.log(
				JSON.stringify({
					mode,
					baselineRssBytes,
					importedRssBytes,
					warmRssBytes: processTreeRssBytes(),
				}),
			);
		} finally {
			await runtime.dispose();
		}
		return;
	}
	throw new Error(`unknown child mode ${mode}`);
}

function printSummary(
	core: Awaited<ReturnType<typeof measureCoreScenarios>>,
	tools: Awaited<ReturnType<typeof measureToolScenarios>>,
): void {
	console.error("");
	console.error(
		"scenario                     node-v8    run-qjs  agent-fresh agent-retained",
	);
	console.error(
		"---------------------------- --------- --------- ----------- --------------",
	);
	for (const scenario of core) {
		const value = (lane: Lane) =>
			`${scenario.results[lane].stats.p50.toFixed(2)} ms`.padStart(9);
		console.error(
			`${scenario.id.padEnd(28)} ${value("node-v8-control")} ${value("vercel-run-fresh")} ${value("agentos-fresh").padStart(11)} ${value("agentos-retained").padStart(14)}`,
		);
	}
	for (const scenario of tools) {
		const value = (lane: Exclude<Lane, "node-v8-control">) =>
			`${scenario.results[lane].stats.p50.toFixed(2)} ms`.padStart(9);
		console.error(
			`${scenario.id.padEnd(28)} ${"n/a".padStart(9)} ${value("vercel-run-fresh")} ${value("agentos-fresh").padStart(11)} ${value("agentos-retained").padStart(14)}`,
		);
	}
}

async function main(): Promise<void> {
	const childIndex = process.argv.indexOf("--child");
	if (childIndex !== -1) {
		await childMain(process.argv[childIndex + 1] ?? "");
		return;
	}

	console.error("=== Vercel Run vs agentOS JavaScript benchmark ===");
	console.error(`Node: ${process.version}`);
	console.error(`Iterations: ${ITERATIONS}; heavy: ${HEAVY_ITERATIONS}`);
	console.error("Collecting isolated cold-start samples...");
	const coldStart = await collectColdStart();
	console.error("Collecting isolated RSS samples...");
	const memory = {
		vercelRun: await runChild("memory-run"),
		agentOS: await runChild("memory-agentos"),
	};

	const [{ run }, { AgentOs, binding, bindings }, { z }] = await Promise.all([
		import("run"),
		import("@rivet-dev/agentos"),
		import("zod"),
	]);
	const tools = bindings({
		name: "tools",
		description: "Host functions used by the runtime comparison benchmark.",
		bindings: {
			echo: binding({
				description: "Echo a string through the host binding bridge.",
				inputSchema: z.object({ value: z.string() }),
				execute: ({ value }) => ({ value }),
			}),
			wait: binding({
				description: "Wait five milliseconds in a host binding.",
				inputSchema: z.object({}),
				async execute() {
					await new Promise((resolve) => setTimeout(resolve, 5));
					return 42;
				},
			}),
		},
	});
	const runtime = await AgentOs.create({
		defaultSoftware: false,
		bindings: [tools],
		permissions: {
			binding: "allow",
			childProcess: "allow",
			fs: "allow",
			process: "allow",
			env: "allow",
			network: "deny",
		},
	});
	try {
		await runtime.createContext("retained-bench");
		await evaluateRun(run, "return 1;");
		await evaluateAgentOs(runtime, "1");
		await evaluateAgentOs(runtime, "1", "retained-bench");

		const coreScenarios = await measureCoreScenarios(run, runtime);
		const toolScenarios = await measureToolScenarios(run, runtime);
		console.error("Measuring parallel scaling...");
		const concurrency = await measureConcurrency(run, runtime);
		printSummary(coreScenarios, toolScenarios);

		let revision = "unknown";
		try {
			revision = execFileSync(
				"jj",
				["log", "-r", "@", "--no-graph", "-T", "commit_id"],
				{
					encoding: "utf8",
					cwd: fileURLToPath(new URL("../../../..", import.meta.url)),
				},
			).trim();
		} catch {
			// The artifact remains useful outside a jj checkout.
		}
		console.log(
			JSON.stringify(
				{
					metadata: {
						createdAt: new Date().toISOString(),
						revision,
						hardware: getHardware(),
						versions: {
							node: process.version,
							vercelRun: "2.0.1",
							quickJsEmscripten: "0.32.0",
						},
						config: {
							warmupIterations: WARMUP_ITERATIONS,
							iterations: ITERATIONS,
							heavyIterations: HEAVY_ITERATIONS,
							coldIterations: COLD_ITERATIONS,
							concurrencyIterations: CONCURRENCY_ITERATIONS,
							timeoutMs: TIMEOUT_MS,
						},
						notes: [
							"Vercel Run 2.0.1 embeds quickjs-emscripten 0.32.0's RELEASE_ASYNC WebAssembly build and creates a fresh QuickJS context per invocation on a reusable worker thread.",
							"agentos-fresh uses the public JavaScript evaluation API without contextId; agentos-retained explicitly reuses one contextId.",
							"node-v8-control uses node:vm in-process and is not a security-equivalent sandbox.",
							"agentOS host bindings are intentionally measured through their public guest CLI surface; Vercel Run exposes direct async JavaScript host functions, so this measures product API overhead rather than a bare bridge primitive.",
							"RSS is summed across the benchmark Node process and descendants; it is not proportional-set-size and can double-count shared pages across processes.",
						],
					},
					coldStart,
					memory,
					coreScenarios,
					toolScenarios,
					concurrency,
				},
				null,
				2,
			),
		);
	} finally {
		await runtime.dispose();
	}
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
