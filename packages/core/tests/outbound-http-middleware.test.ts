import { afterEach, describe, expect, test } from "vitest";
import { AgentOs, type AgentOsOptions } from "../src/index.js";

const decoder = new TextDecoder();
const activeVms = new Set<AgentOs>();

async function createVm(
	options: Pick<
		AgentOsOptions,
		"limits" | "outbound" | "outboundByHost" | "permissions"
	>,
): Promise<AgentOs> {
	const vm = await AgentOs.create({
		defaultSoftware: false,
		permissions: {
			fs: "allow",
			network: "allow",
			childProcess: "allow",
		},
		...options,
	});
	activeVms.add(vm);
	return vm;
}

async function runNode(vm: AgentOs, source: string): Promise<string> {
	const stdout: Uint8Array[] = [];
	const stderr: Uint8Array[] = [];
	const { pid } = vm.spawn("node", ["-e", source], {
		onStdout: (chunk) => stdout.push(chunk),
		onStderr: (chunk) => stderr.push(chunk),
	});
	const exitCode = await vm.waitProcess(pid);
	const stderrText = stderr.map((chunk) => decoder.decode(chunk)).join("");
	expect(exitCode, stderrText).toBe(0);
	expect(stderrText).toBe("");
	return stdout
		.map((chunk) => decoder.decode(chunk))
		.join("")
		.trim();
}

afterEach(async () => {
	const vms = [...activeVms];
	activeVms.clear();
	await Promise.all(vms.map((vm) => vm.dispose()));
});

describe("outbound HTTP middleware", () => {
	test("intercepts virtual HTTPS fetches with exact-host precedence", async () => {
		const requests: Array<{
			method: string;
			url: string;
			header: string | null;
			body: string;
		}> = [];
		const vm = await createVm({
			outbound: () => new Response("fallback", { status: 202 }),
			outboundByHost: {
				"API.Example.COM.": async (request) => {
					requests.push({
						method: request.method,
						url: request.url,
						header: request.headers.get("x-guest"),
						body: await request.text(),
					});
					const stream = new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(new TextEncoder().encode("event: one\n\n"));
							controller.enqueue(new TextEncoder().encode("event: two\n\n"));
							controller.close();
						},
					});
					return new Response(stream, {
						status: 201,
						headers: {
							"content-type": "text/event-stream",
							"x-middleware": "exact",
						},
					});
				},
			},
		});

		const stdout = await runNode(
			vm,
			[
				"(async () => {",
				'  const exact = await fetch("https://api.example.com:8443/v1/chat?stream=1", {',
				'    method: "POST",',
				'    headers: { "x-guest": "yes", "content-type": "text/plain" },',
				'    body: "prompt",',
				"  });",
				'  const fallback = await fetch("http://other.invalid/test");',
				"  console.log(JSON.stringify({",
				"    exactStatus: exact.status,",
				'    exactHeader: exact.headers.get("x-middleware"),',
				"    exactBody: await exact.text(),",
				"    fallbackStatus: fallback.status,",
				"    fallbackBody: await fallback.text(),",
				"  }));",
				"})().catch((error) => { console.error(error?.stack ?? String(error)); process.exit(1); });",
			].join("\n"),
		);

		expect(JSON.parse(stdout)).toEqual({
			exactStatus: 201,
			exactHeader: "exact",
			exactBody: "event: one\n\nevent: two\n\n",
			fallbackStatus: 202,
			fallbackBody: "fallback",
		});
		expect(requests).toEqual([
			{
				method: "POST",
				url: "https://api.example.com:8443/v1/chat?stream=1",
				header: "yes",
				body: "prompt",
			},
		]);
	});

	test("intercepts node:http without opening an upstream socket", async () => {
		const vm = await createVm({
			outboundByHost: {
				"llm.invalid": async (request) => {
					return Response.json(
						{
							method: request.method,
							path: new URL(request.url).pathname,
							authorization: request.headers.get("authorization"),
							connection: request.headers.get("connection"),
							contentLength: request.headers.get("content-length"),
							host: request.headers.get("host"),
							privateHeader: request.headers.get("x-private"),
							body: await request.text(),
						},
						{
							status: 207,
							headers: {
								connection: "x-response-private",
								"content-encoding": "gzip",
								"content-length": "999",
								etag: '"stale"',
								"x-mocked": "true",
								"x-response-private": "secret",
							},
						},
					);
				},
			},
		});

		const stdout = await runNode(
			vm,
			[
				'const http = require("node:http");',
				'const req = http.request("http://llm.invalid/v1/responses", {',
				'  method: "POST",',
				'  headers: { authorization: "Bearer test", connection: "x-private", "content-length": "11", "x-private": "secret" },',
				"}, (res) => {",
				'  let body = "";',
				'  res.setEncoding("utf8");',
				'  res.on("data", (chunk) => { body += chunk; });',
				'  res.on("end", () => console.log(JSON.stringify({',
				"    status: res.statusCode,",
				'    mocked: res.headers["x-mocked"],',
				'    connection: res.headers["connection"] ?? null,',
				'    contentEncoding: res.headers["content-encoding"] ?? null,',
				'    contentLength: res.headers["content-length"] ?? null,',
				'    etag: res.headers["etag"] ?? null,',
				'    privateHeader: res.headers["x-response-private"] ?? null,',
				"    body: JSON.parse(body),",
				"  })));",
				"});",
				'req.on("error", (error) => { console.error(error?.stack ?? String(error)); process.exit(1); });',
				'req.write("hello ");',
				'req.end("world");',
			].join("\n"),
		);

		expect(JSON.parse(stdout)).toEqual({
			status: 207,
			mocked: "true",
			connection: null,
			contentEncoding: null,
			contentLength: null,
			etag: null,
			privateHeader: null,
			body: {
				method: "POST",
				path: "/v1/responses",
				authorization: "Bearer test",
				connection: null,
				contentLength: null,
				host: null,
				privateHeader: null,
				body: "hello world",
			},
		});
	});

	test("preserves HTTP body semantics for HEAD responses", async () => {
		const vm = await createVm({
			outboundByHost: {
				"api.example.com": () =>
					new Response("this body must not reach the guest", {
						status: 200,
						headers: {
							"content-length": "35",
							"x-result": "head",
						},
					}),
			},
		});

		const stdout = await runNode(
			vm,
			[
				"(async () => {",
				'  const response = await fetch("https://api.example.com/value", { method: "HEAD" });',
				"  console.log(JSON.stringify({",
				"    status: response.status,",
				'    result: response.headers.get("x-result"),',
				'    contentLength: response.headers.get("content-length"),',
				"    body: await response.text(),",
				"  }));",
				"})().catch((error) => { console.error(error?.stack ?? String(error)); process.exit(1); });",
			].join("\n"),
		);

		expect(JSON.parse(stdout)).toEqual({
			status: 200,
			result: "head",
			contentLength: null,
			body: "",
		});
	});

	test("maps middleware failures to a generic HTTP response", async () => {
		const vm = await createVm({
			outboundByHost: {
				"api.example.com": () => {
					throw new Error("secret host implementation detail");
				},
			},
		});

		const stdout = await runNode(
			vm,
			[
				"(async () => {",
				'  const response = await fetch("https://api.example.com/fail");',
				"  console.log(JSON.stringify({ status: response.status, body: await response.text() }));",
				"})().catch((error) => { console.error(error?.stack ?? String(error)); process.exit(1); });",
			].join("\n"),
		);

		expect(JSON.parse(stdout)).toEqual({
			status: 500,
			body: "Outbound HTTP middleware failed",
		});
		expect(stdout).not.toContain("secret host implementation detail");
	});

	test("leaves unmatched HTTP on the direct network path", async () => {
		const vm = await createVm({
			outboundByHost: {
				"api.example.com": () => new Response("mock"),
			},
		});
		const stdout = await runNode(
			vm,
			[
				'const http = require("node:http");',
				"const origin = http.createServer((request, response) => {",
				'  response.writeHead(200, { "content-type": "text/plain" });',
				"  response.end(`origin:${request.url}`);",
				"});",
				'origin.listen(0, "127.0.0.1", async () => {',
				"  try {",
				"    const address = origin.address();",
				"    const response = await fetch(`http://127.0.0.1:${address.port}/direct`);",
				"    console.log(JSON.stringify({ status: response.status, body: await response.text() }));",
				"    origin.close();",
				"  } catch (error) {",
				"    console.error(error?.stack ?? String(error));",
				"    origin.close(() => process.exit(1));",
				"  }",
				"});",
			].join("\n"),
		);
		expect(JSON.parse(stdout)).toEqual({
			status: 200,
			body: "origin:/direct",
		});
	});

	test("checks network permission before invoking middleware", async () => {
		let invocations = 0;
		const vm = await createVm({
			permissions: {
				fs: "allow",
				network: "deny",
				childProcess: "allow",
			},
			outboundByHost: {
				"api.example.com": () => {
					invocations += 1;
					return new Response("must not run");
				},
			},
		});

		const stdout = await runNode(
			vm,
			[
				"(async () => {",
				"  try {",
				'    await fetch("https://api.example.com/denied");',
				'    console.log("unexpected success");',
				"  } catch (error) {",
				"    console.log(String(error?.cause?.message ?? error?.message ?? error));",
				"  }",
				"})();",
			].join("\n"),
		);

		expect(stdout).toMatch(/EACCES|access denied|blocked.*network/i);
		expect(invocations).toBe(0);
	});

	test("rejects invalid, duplicate, and over-limit exact routes", async () => {
		const middleware = () => new Response("ok");

		await expect(
			createVm({
				outboundByHost: {
					"https://api.example.com": middleware,
				},
			}),
		).rejects.toThrow(/outbound HTTP middleware host|hostname|route/i);

		await expect(
			createVm({
				outboundByHost: {
					"API.Example.COM.": middleware,
					"api.example.com": middleware,
				},
			}),
		).rejects.toThrow(/duplicate.*canonical|duplicate.*outbound/i);

		await expect(
			createVm({
				limits: {
					outboundHttp: {
						maxExactMiddlewareRoutes: 1,
					},
				},
				outboundByHost: {
					"first.example.com": middleware,
					"second.example.com": middleware,
				},
			}),
		).rejects.toThrow(/limits\.outboundHttp\.maxExactMiddlewareRoutes/);
	});

	test("maps an oversized middleware response to a generic 500", async () => {
		const vm = await createVm({
			limits: {
				outboundHttp: {
					maxBufferedResponseBytes: 4,
				},
			},
			outbound: () => new Response("12345"),
		});

		const stdout = await runNode(
			vm,
			[
				"(async () => {",
				'  const response = await fetch("https://api.example.com/large");',
				"  console.log(JSON.stringify({ status: response.status, body: await response.text() }));",
				"})().catch((error) => { console.error(error?.stack ?? String(error)); process.exit(1); });",
			].join("\n"),
		);

		expect(JSON.parse(stdout)).toEqual({
			status: 500,
			body: "Outbound HTTP middleware failed",
		});
		expect(stdout).not.toContain("maxBufferedResponseBytes");
	});

	test("rejects an oversized request body before middleware invocation", async () => {
		let invocations = 0;
		const vm = await createVm({
			limits: {
				outboundHttp: {
					maxRequestBodyBytes: 4,
				},
			},
			outbound: () => {
				invocations += 1;
				return new Response("must not run");
			},
		});

		const stdout = await runNode(
			vm,
			[
				"(async () => {",
				'  const response = await fetch("https://api.example.com/large", { method: "POST", body: "12345" });',
				"  console.log(JSON.stringify({ status: response.status, body: await response.text() }));",
				"})().catch((error) => { console.error(error?.stack ?? String(error)); process.exit(1); });",
			].join("\n"),
		);

		expect(JSON.parse(stdout)).toEqual({
			status: 413,
			body: "Outbound HTTP request body too large",
		});
		expect(invocations).toBe(0);
	});

	test("maps the middleware response deadline to 504", async () => {
		const vm = await createVm({
			limits: {
				outboundHttp: {
					middlewareResponseTimeoutMs: 50,
				},
			},
			outbound: (request) =>
				new Promise<Response>((_resolve, reject) => {
					const abort = () => reject(request.signal.reason);
					if (request.signal.aborted) {
						abort();
					} else {
						request.signal.addEventListener("abort", abort, { once: true });
					}
				}),
		});

		const stdout = await runNode(
			vm,
			[
				"(async () => {",
				'  const response = await fetch("https://api.example.com/slow");',
				"  console.log(JSON.stringify({ status: response.status, body: await response.text() }));",
				"})().catch((error) => { console.error(error?.stack ?? String(error)); process.exit(1); });",
			].join("\n"),
		);

		expect(JSON.parse(stdout)).toEqual({
			status: 504,
			body: "Outbound HTTP middleware failed",
		});
	});

	test("isolates middleware routes between VMs sharing a sidecar", async () => {
		const [first, second] = await Promise.all([
			createVm({
				outboundByHost: {
					"shared.invalid": () => new Response("first"),
				},
			}),
			createVm({
				outboundByHost: {
					"shared.invalid": () => new Response("second"),
				},
			}),
		]);

		const source = [
			"(async () => {",
			'  const response = await fetch("https://shared.invalid/value");',
			"  console.log(await response.text());",
			"})().catch((error) => { console.error(error?.stack ?? String(error)); process.exit(1); });",
		].join("\n");
		const [firstOutput, secondOutput] = await Promise.all([
			runNode(first, source),
			runNode(second, source),
		]);
		expect(firstOutput).toBe("first");
		expect(secondOutput).toBe("second");
	});
});
