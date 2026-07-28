// The builder agent: an Anthropic tool-runner loop with write_files → deploy →
// http_request / read_logs / browser_test tools. There is no dev VM — deploy
// is the compile check and the live deployment is the test target.
import Anthropic from "@anthropic-ai/sdk";
import { betaTool } from "@anthropic-ai/sdk/helpers/beta/json-schema";
import { AgentOSAppsError, deployApp } from "@rivet-dev/agentos-apps";
import { browserTest, type BrowserAction } from "./browser.js";
import { client } from "./client.js";
import type { LogCollector } from "./logs.js";
import { systemPrompt } from "./systemPrompt.js";
import type { AgentEvent, Block } from "./types.js";

const anthropic = new Anthropic();
const MODEL = process.env.AI_MODEL ?? "claude-opus-5";
const MAX_FILE_BYTES = 64 * 1024;
const MAX_FILES = 12;
const MAX_BODY_BYTES = 16 * 1024;
const MAX_ITERATIONS = 40;

export interface RunAgentOptions {
	appId: string;
	prompt: string;
	baseUrl: string; // e.g. http://127.0.0.1:3001
	logCollector: LogCollector;
	send: (event: AgentEvent) => void;
}

function formatDeployError(error: unknown): string {
	if (
		error instanceof AgentOSAppsError ||
		(typeof error === "object" && error !== null && "code" in error)
	) {
		const details = error as {
			code?: string;
			message?: string;
			metadata?: unknown;
			serverFault?: boolean;
		};
		return JSON.stringify(
			{
				code: details.code,
				message: details.message,
				serverFault: details.serverFault,
				metadata: details.metadata,
			},
			null,
			2,
		).slice(0, MAX_BODY_BYTES);
	}
	return String(error).slice(0, MAX_BODY_BYTES);
}

export async function runAgent(options: RunAgentOptions): Promise<void> {
	const { appId, prompt, baseUrl, logCollector, send } = options;
	const app = client.builderApp.getOrCreate([appId]);
	const directory = client.builderDirectory.getOrCreate(["main"]);

	const detail = await app.detail();
	let releaseCounter = detail.release;
	let lastDeployOk: boolean | null = null;

	const blocks: Block[] = [];
	const pushBlock = (block: Block) => {
		blocks.push(block);
		send({ type: "block", block });
	};
	const replaceLastBlock = (block: Block) => {
		blocks[blocks.length - 1] = block;
		send({ type: "block", block, replaceLast: true });
	};

	await app.appendUserMessage(prompt);
	await app.setStatus("building");
	await directory.setStatus(appId, "building");
	send({ type: "status", status: "building" });

	const writeFilesTool = betaTool({
		name: "write_files",
		description:
			"Stage full file contents for the app. Existing files not listed are kept. Always write complete file bodies, never diffs.",
		inputSchema: {
			type: "object",
			properties: {
				files: {
					type: "array",
					items: {
						type: "object",
						properties: {
							path: { type: "string", description: "Relative path, e.g. src/index.ts" },
							content: { type: "string" },
						},
						required: ["path", "content"],
					},
				},
			},
			required: ["files"],
		},
		run: async (input) => {
			const { files } = input as { files: { path: string; content: string }[] };
			const staged: Record<string, string> = {};
			for (const file of files) {
				if (!/^[a-zA-Z0-9._/-]+$/.test(file.path) || file.path.includes("..")) {
					return JSON.stringify({ ok: false, error: `invalid path: ${file.path}` });
				}
				if (Buffer.byteLength(file.content) > MAX_FILE_BYTES) {
					return JSON.stringify({ ok: false, error: `${file.path} exceeds ${MAX_FILE_BYTES} bytes` });
				}
				staged[file.path] = file.content;
			}
			const existing = await app.getFiles();
			if (Object.keys({ ...existing, ...staged }).length > MAX_FILES) {
				return JSON.stringify({ ok: false, error: `project exceeds ${MAX_FILES} files` });
			}
			await app.writeFiles(staged);
			for (const path of Object.keys(staged)) pushBlock({ kind: "file", path });
			return JSON.stringify({ ok: true, wrote: Object.keys(staged) });
		},
	});

	const deployTool = betaTool({
		name: "deploy",
		description:
			"Build and release the staged files with deployApp(). On success the live release is replaced atomically and the result includes the live URL to test against. On failure, build diagnostics are returned and the previous release keeps serving.",
		inputSchema: { type: "object", properties: {} },
		run: async () => {
			const files = await app.getFiles();
			if (Object.keys(files).length === 0) {
				return JSON.stringify({ ok: false, error: "no files staged — call write_files first" });
			}
			const attempt = releaseCounter + 1;
			pushBlock({ kind: "deploy", release: attempt, pending: true });
			send({ type: "overlay", text: `Deploying release #${attempt}…` });
			try {
				const deployment = await deployApp({
					appId,
					files,
				});
				releaseCounter = attempt;
				lastDeployOk = true;
				replaceLastBlock({ kind: "deploy", release: attempt, ok: true });
				await app.setStatus("building", attempt);
				send({ type: "status", status: "building", release: attempt });
				send({ type: "overlay", text: `Loading release #${attempt}…` });
				send({ type: "preview-reload" });
				setTimeout(() => send({ type: "overlay", text: null }), 800);
				// Old-release replicas stop serving; drop their log subscriptions.
				await logCollector.pruneApp(appId);
				return JSON.stringify({
					ok: true,
					release: attempt,
					releaseHash: deployment.release,
					liveUrl: `${baseUrl}/apps/${appId}/`,
					note: "Test this deployment now with http_request / browser_test before replying.",
				});
			} catch (error) {
				lastDeployOk = false;
				const diagnostics = formatDeployError(error);
				replaceLastBlock({ kind: "deploy", release: attempt, ok: false, diagnostics });
				send({ type: "overlay", text: null });
				return JSON.stringify({ ok: false, diagnostics });
			}
		},
	});

	const httpRequestTool = betaTool({
		name: "http_request",
		description:
			"Send an HTTP request to the LIVE deployed app. path is relative to the app root, e.g. \"/\" or \"/api/items\". Returns status and the first 16KB of the body.",
		inputSchema: {
			type: "object",
			properties: {
				method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
				path: { type: "string" },
				body: { type: "string", description: "Optional request body (usually JSON)" },
				content_type: { type: "string" },
			},
			required: ["method", "path"],
		},
		run: async (input) => {
			const { method, path, body, content_type } = input as {
				method: string;
				path: string;
				body?: string;
				content_type?: string;
			};
			const normalized = path.startsWith("/") ? path : `/${path}`;
			const url = `${baseUrl}/apps/${appId}${normalized}`;
			const started = Date.now();
			try {
				const response = await fetch(url, {
					method,
					body: body ?? undefined,
					headers: body ? { "content-type": content_type ?? "application/json" } : undefined,
					signal: AbortSignal.timeout(30_000),
				});
				const ms = Date.now() - started;
				const text = (await response.text()).slice(0, MAX_BODY_BYTES);
				const replica = response.headers.get("x-agentos-app-replica");
				if (replica) logCollector.track(appId, replica);
				pushBlock({
					kind: "http-tests",
					rows: [{ method, path: normalized, status: response.status, ms }],
				});
				return JSON.stringify({
					status: response.status,
					ms,
					contentType: response.headers.get("content-type"),
					body: text,
				});
			} catch (error) {
				const ms = Date.now() - started;
				pushBlock({ kind: "http-tests", rows: [{ method, path: normalized, status: 0, ms }] });
				return JSON.stringify({ status: 0, error: String(error), ms });
			}
		},
	});

	const readLogsTool = betaTool({
		name: "read_logs",
		description:
			"Read recent runtime console/stderr output captured from the deployed app's VM. Use after testing to check for runtime errors.",
		inputSchema: {
			type: "object",
			properties: {
				limit: { type: "integer", description: "Max lines, default 100" },
			},
		},
		run: async (input) => {
			const { limit } = input as { limit?: number };
			const rows = await app.readLogs(limit ?? 100);
			const errorCount = rows.filter((r) => r.stream === "stderr").length;
			pushBlock({
				kind: "logs",
				summary: `${rows.length} lines · ${errorCount} stderr`,
			});
			return JSON.stringify({
				lines: rows.map((r) => `[${r.stream}] ${r.line}`),
				note:
					rows.length === 0
						? "No output captured yet. Log capture attaches to replicas observed serving requests — make an http_request first, then re-check."
						: undefined,
			});
		},
	});

	const browserTestTool = betaTool({
		name: "browser_test",
		description:
			"Load the LIVE deployed app in a real headless browser. Optionally click/fill elements, then get back rendered page text, console errors, and text-expectation results. Use for UI-facing changes.",
		inputSchema: {
			type: "object",
			properties: {
				path: { type: "string", description: "Path relative to app root, e.g. \"/\"" },
				actions: {
					type: "array",
					items: {
						type: "object",
						properties: {
							type: { type: "string", enum: ["click", "fill", "wait_for"] },
							selector: { type: "string" },
							text: { type: "string" },
						},
						required: ["type", "selector"],
					},
				},
				expect_texts: {
					type: "array",
					items: { type: "string" },
					description: "Strings that must appear in the rendered page text",
				},
			},
			required: ["path"],
		},
		run: async (input) => {
			const { path, actions, expect_texts } = input as {
				path: string;
				actions?: BrowserAction[];
				expect_texts?: string[];
			};
			pushBlock({ kind: "browser-test", pending: true });
			try {
				const normalized = path.startsWith("/") ? path : `/${path}`;
				const result = await browserTest({
					url: `${baseUrl}/apps/${appId}${normalized}`,
					actions,
					expect_texts,
				});
				const checks = [
					...result.checks.map((c) => `${c.found ? "" : "MISSING: "}${c.text}`),
					`${result.consoleErrors.length} console errors`,
					...(result.actionErrors.length > 0
						? [`${result.actionErrors.length} failed actions`]
						: []),
				];
				replaceLastBlock({ kind: "browser-test", checks });
				return JSON.stringify(result);
			} catch (error) {
				replaceLastBlock({
					kind: "browser-test",
					checks: [`browser test failed: ${String(error).slice(0, 200)}`],
				});
				return JSON.stringify({ ok: false, error: String(error) });
			}
		},
	});

	const files = await app.getFiles();
	const filesContext =
		Object.keys(files).length > 0
			? `Current files:\n${JSON.stringify(files)}`
			: "There are no files yet — this is a brand new app.";

	try {
		const runner = anthropic.beta.messages.toolRunner({
			model: MODEL,
			max_tokens: 16_000,
			system: systemPrompt(appId),
			tools: [writeFilesTool, deployTool, httpRequestTool, readLogsTool, browserTestTool],
			messages: [
				{
					role: "user",
					content: `${filesContext}\n\nUser request: ${prompt}`,
				},
			],
			max_iterations: MAX_ITERATIONS,
		});

		for await (const message of runner) {
			for (const block of message.content) {
				if (block.type === "text" && block.text.trim().length > 0) {
					pushBlock({ kind: "text", text: block.text });
				}
			}
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		pushBlock({ kind: "text", text: `Agent run failed: ${message}` });
		send({ type: "error", message });
	}

	// Persist the exchange and settle status.
	const finalBlocks = blocks.filter(
		(b) => !("pending" in b && b.pending),
	);
	await app.appendAgentMessage(finalBlocks);
	let status: "live" | "failed" | "building";
	if (lastDeployOk === true) status = "live";
	else if (lastDeployOk === false) status = releaseCounter > 0 ? "failed" : "failed";
	else status = detail.status === "building" ? (releaseCounter > 0 ? "live" : "failed") : detail.status;
	await app.setStatus(status, releaseCounter);
	await directory.setStatus(appId, status, releaseCounter);
	send({ type: "status", status, release: releaseCounter });
	send({ type: "done" });
}
