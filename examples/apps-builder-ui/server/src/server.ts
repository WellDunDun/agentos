import { serve } from "@hono/node-server";
import { appsRouter } from "@rivet-dev/agentos-apps";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { runAgent } from "./agent.js";
import { registry } from "./actors.js";
import { client } from "./client.js";
import { LogCollector } from "./logs.js";
import { systemPrompt } from "./systemPrompt.js";
import type { AgentEvent } from "./types.js";

if (!process.env.ANTHROPIC_API_KEY) {
	throw new Error("ANTHROPIC_API_KEY is required to run the builder agent");
}

const PORT = Number(process.env.PORT ?? 3001);
const BASE_URL = `http://127.0.0.1:${PORT}`;

registry.start();

const logCollector = new LogCollector(client);
const directory = () => client.builderDirectory.getOrCreate(["main"]);

function slugify(prompt: string): { id: string; name: string } {
	const words = prompt
		.replace(/[^a-zA-Z0-9 ]/g, "")
		.split(/\s+/)
		.filter(
			(w) =>
				w.length > 2 &&
				!/^(the|and|for|with|that|app|build|make|create)$/i.test(w),
		);
	const name =
		words
			.slice(0, 2)
			.map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase())
			.join(" ") || "New App";
	const id =
		name
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "") || "app";
	return { id, name };
}

const server = new Hono();

server.get("/api/apps", async (c) => {
	return c.json(await directory().list());
});

server.post("/api/apps", async (c) => {
	const body = await c.req.json<{ prompt?: unknown }>();
	if (
		typeof body.prompt !== "string" ||
		body.prompt.trim().length === 0 ||
		body.prompt.length > 4_000
	) {
		return c.json({ error: "prompt must be 1-4000 characters" }, 400);
	}
	const prompt = body.prompt.trim();
	let { id, name } = slugify(prompt);
	const existing = await directory().list();
	if (existing.some((app) => app.id === id)) {
		id = `${id}-${Math.floor(Math.random() * 900 + 100)}`;
	}
	await directory().create({ id, name, prompt });
	await client.builderApp.getOrCreate([id]).init({ name, prompt });
	return c.json({ id, name, status: "building", release: 0, prompt, updatedAt: Date.now() });
});

server.get("/api/apps/:id", async (c) => {
	const id = c.req.param("id");
	const apps = await directory().list();
	if (!apps.some((app) => app.id === id)) {
		return c.json({ error: "app not found" }, 404);
	}
	const detail = await client.builderApp.getOrCreate([id]).detail();
	return c.json({ id, ...detail, updatedAt: Date.now() });
});

server.post("/api/apps/:id/take-pending", async (c) => {
	const id = c.req.param("id");
	const prompt = await client.builderApp.getOrCreate([id]).takePendingFirstPrompt();
	return c.json({ prompt });
});

server.post("/api/apps/:id/messages", async (c) => {
	const id = c.req.param("id");
	const body = await c.req.json<{ prompt?: unknown }>();
	if (
		typeof body.prompt !== "string" ||
		body.prompt.trim().length === 0 ||
		body.prompt.length > 4_000
	) {
		return c.json({ error: "prompt must be 1-4000 characters" }, 400);
	}
	const apps = await directory().list();
	if (!apps.some((app) => app.id === id)) {
		return c.json({ error: "app not found" }, 404);
	}
	const prompt = body.prompt.trim();
	const app = client.builderApp.getOrCreate([id]);
	const acquired = await app.tryAcquireRun();
	if (!acquired) {
		return c.json({ error: "the agent is already handling a prompt for this app" }, 409);
	}
	return streamSSE(c, async (stream) => {
		let disconnected = false;
		const send = (event: AgentEvent) => {
			if (disconnected) return;
			stream
				.writeSSE({ data: JSON.stringify(event) })
				.catch(() => {
					// Client went away; keep the run going — state is persisted in
					// the builderApp actor and the UI recovers it on reload.
					disconnected = true;
					console.warn(`[builder] SSE client disconnected for ${id}; run continues`);
				});
		};
		try {
			await runAgent({ appId: id, prompt, baseUrl: BASE_URL, logCollector, send });
		} catch (error) {
			console.error(`[builder] agent run for ${id} failed`, error);
			send({ type: "error", message: error instanceof Error ? error.message : String(error) });
		} finally {
			await app.releaseRun();
		}
	});
});

server.get("/api/apps/:id/inspector", async (c) => {
	const id = c.req.param("id");
	const rawEndpoint =
		process.env.RIVET_ENGINE ?? process.env.RIVET_ENDPOINT ?? "http://localhost:6420";
	const url = new URL(rawEndpoint);
	url.username = "";
	url.password = "";
	const endpoint = url.toString().replace(/\/$/, "");
	const namespace = process.env.RIVET_NAMESPACE ?? "default";
	return c.json({
		appId: id,
		deploymentActor: `agentOSAppsApp:${id}`,
		namespace,
		endpoint,
		selfHostedUrl: `${endpoint}/`,
		cloudUrl: `https://dashboard.rivet.dev/?namespace=${encodeURIComponent(namespace)}&actor=${encodeURIComponent(`agentOSAppsApp:${id}`)}`,
	});
});

server.get("/api/system-prompt", (c) => {
	return c.text(systemPrompt("<app-id>"));
});

// Capture the serving replica of every response that flows through the apps
// router so its runtime output lands in the app's log table.
server.use("/apps/*", async (c, next) => {
	await next();
	const replica = c.res.headers.get("x-agentos-app-replica");
	if (replica) {
		const appId = replica.split("/")[0];
		if (appId) logCollector.track(appId, replica);
	}
});
server.route("/apps", appsRouter);

serve({ fetch: server.fetch, port: PORT });
console.log(`[builder] API + apps host listening on ${BASE_URL}`);
