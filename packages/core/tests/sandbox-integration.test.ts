import common from "@agentos-software/common";
import {
	createSandboxFs,
} from "@rivet-dev/agentos-sandbox";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { z } from "zod";
import { AgentOs, binding, bindingGroup } from "../src/index.js";
import type { MockSandboxAgentHandle } from "../src/test/sandbox-agent.js";
import { startMockSandboxAgent } from "../src/test/sandbox-agent.js";

const SANDBOX_QUICKSTART_PERMISSIONS = {
	fs: "allow",
	network: "allow",
	childProcess: "allow",
	env: "allow",
	binding: "allow",
} as const;

const SANDBOX_MOUNT_PATH = "/sandbox";
const SANDBOX_FILE_PATH = `${SANDBOX_MOUNT_PATH}/hello.txt`;
const SANDBOX_FILE_CONTENT = "Hello from agentOS!";

function createSandboxBindingGroup(options: MockSandboxAgentHandle) {
	const { client } = options;

	return bindingGroup({
		name: "sandbox",
		description:
			"Execute commands and manage processes in a remote sandbox environment.",
		bindings: {
			"run-command": binding({
				description:
					"Run a command synchronously in the sandbox and return its stdout, stderr, and exit code.",
				inputSchema: z.object({
					command: z.string(),
					args: z.array(z.string()).optional(),
					cwd: z.string().optional(),
					env: z.record(z.string(), z.string()).optional(),
					timeoutMs: z.number().optional(),
				}),
				timeout: 120_000,
				execute: async (input) => {
					const result = await client.runProcess(input);
					return {
						stdout: result.stdout,
						stderr: result.stderr,
						exitCode: result.exitCode,
						timedOut: result.timedOut,
						durationMs: result.durationMs,
					};
				},
			}),
			"create-process": binding({
				description: "Start a long-running background process in the sandbox.",
				inputSchema: z.object({
					command: z.string(),
					args: z.array(z.string()).optional(),
					cwd: z.string().optional(),
					env: z.record(z.string(), z.string()).optional(),
				}),
				execute: async (input) => {
					const proc = await client.createProcess(input);
					return {
						id: proc.id,
						command: proc.command,
						args: proc.args,
						status: proc.status,
						pid: proc.pid,
					};
				},
			}),
			"list-processes": binding({
				description: "List all processes running in the sandbox.",
				inputSchema: z.object({}),
				execute: async () => {
					const result = await client.listProcesses();
					return {
						processes: result.processes.map((process) => ({
							id: process.id,
							command: process.command,
							args: process.args,
							status: process.status,
							exitCode: process.exitCode,
							pid: process.pid,
						})),
					};
				},
			}),
			"kill-process": binding({
				description: "Forcefully kill a running process in the sandbox.",
				inputSchema: z.object({
					id: z.string(),
				}),
				execute: async (input) => {
					const proc = await client.killProcess(input.id);
					return {
						id: proc.id,
						status: proc.status,
						exitCode: proc.exitCode,
					};
				},
			}),
		},
	});
}

describe("sandbox quickstart truth test", () => {
	let sandbox: MockSandboxAgentHandle | null = null;
	let vm: AgentOs | null = null;

	beforeAll(async () => {
		sandbox = await startMockSandboxAgent();
	}, 150_000);

	afterEach(async () => {
		if (vm) {
			await vm.dispose();
			vm = null;
		}
	});

	afterAll(async () => {
		if (vm) {
			await vm.dispose();
			vm = null;
		}
		if (sandbox) {
			await sandbox.stop();
			sandbox = null;
		}
	});

	test("mounts createSandboxFs and exercises run-command plus list-processes from createSandboxBindingGroup", async () => {
		if (!sandbox) {
			throw new Error("Sandbox test harness did not start.");
		}

		vm = await AgentOs.create({
			permissions: SANDBOX_QUICKSTART_PERMISSIONS,
			software: [common],
			mounts: [
				{
					path: SANDBOX_MOUNT_PATH,
					plugin: createSandboxFs({ client: sandbox.client }),
				},
			],
			bindings: [createSandboxBindingGroup(sandbox)],
		});

		await sandbox.client.writeFsFile(
			{ path: "/hello.txt" },
			new TextEncoder().encode(SANDBOX_FILE_CONTENT),
		);
		const content = await vm.readFile(SANDBOX_FILE_PATH);
		expect(new TextDecoder().decode(content)).toBe(SANDBOX_FILE_CONTENT);

		const bindingGroup = createSandboxBindingGroup(sandbox);
		const runCommandResponse = (await bindingGroup.bindings["run-command"].execute({
			command: "echo",
			args: ["hello from sandbox"],
		})) as {
			stdout: string;
			stderr: string;
			exitCode: number;
		};
		expect(runCommandResponse.exitCode).toBe(0);
		expect(runCommandResponse.stderr).toBe("");
		expect(runCommandResponse.stdout.trim()).toBe("hello from sandbox");

		const createdProcess = (await bindingGroup.bindings["create-process"].execute({
			command: "sleep",
			args: ["60"],
		})) as {
			id: string;
			status: string;
		};
		expect(createdProcess.status).toBe("running");

		const listProcessesResponse = (await bindingGroup.bindings[
			"list-processes"
		].execute({})) as {
			processes: Array<{
				command: string;
				args?: string[];
				status: string;
			}>;
		};
		expect(Array.isArray(listProcessesResponse.processes)).toBe(true);
		expect(listProcessesResponse.processes.length).toBeGreaterThan(0);
		expect(
			listProcessesResponse.processes.some(
				(processInfo) =>
					processInfo.status === "running" && processInfo.command === "sleep",
			),
		).toBe(true);

		await bindingGroup.bindings["kill-process"].execute({ id: createdProcess.id });
	}, 150_000);
});
