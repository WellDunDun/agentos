// HTTP client for the builder backend. In dev, Vite proxies /api and /apps to
// the server (see vite.config.ts).
import type {
	AgentEvent,
	AppDetail,
	AppSummary,
	InspectorInfo,
} from "./types";

async function json<T>(response: Response): Promise<T> {
	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new Error(`${response.status}: ${body.slice(0, 300)}`);
	}
	return (await response.json()) as T;
}

export async function listApps(): Promise<AppSummary[]> {
	return json(await fetch("/api/apps"));
}

export async function getApp(id: string): Promise<AppDetail> {
	return json(await fetch(`/api/apps/${id}`));
}

export async function createApp(prompt: string): Promise<AppSummary> {
	return json(
		await fetch("/api/apps", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ prompt }),
		}),
	);
}

export async function takePendingFirstPrompt(
	id: string,
): Promise<string | null> {
	const result = await json<{ prompt: string | null }>(
		await fetch(`/api/apps/${id}/take-pending`, { method: "POST" }),
	);
	return result.prompt;
}

/**
 * Send a prompt and consume the SSE stream of agent events. Resolves when the
 * stream ends. Throws on a non-2xx response (e.g. 409 while a run is active).
 */
export async function sendPrompt(
	id: string,
	prompt: string,
	onEvent: (event: AgentEvent) => void,
): Promise<void> {
	const response = await fetch(`/api/apps/${id}/messages`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ prompt }),
	});
	if (!response.ok || !response.body) {
		const body = await response.text().catch(() => "");
		throw new Error(`${response.status}: ${body.slice(0, 300)}`);
	}
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		for (;;) {
			const boundary = buffer.indexOf("\n\n");
			if (boundary < 0) break;
			const chunk = buffer.slice(0, boundary);
			buffer = buffer.slice(boundary + 2);
			for (const line of chunk.split("\n")) {
				if (line.startsWith("data: ")) {
					onEvent(JSON.parse(line.slice(6)) as AgentEvent);
				}
			}
		}
	}
}

export async function getInspectorInfo(id: string): Promise<InspectorInfo> {
	return json(await fetch(`/api/apps/${id}/inspector`));
}

export async function getSystemPrompt(): Promise<string> {
	const response = await fetch("/api/system-prompt");
	return response.text();
}

export function appUrl(id: string): string {
	return `/apps/${id}/`;
}

export function formatUpdatedAt(timestamp: number): string {
	const delta = Date.now() - timestamp;
	if (delta < 60_000) return "just now";
	if (delta < 3_600_000) return `${Math.round(delta / 60_000)}m ago`;
	if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)}h ago`;
	return `${Math.round(delta / 86_400_000)}d ago`;
}
