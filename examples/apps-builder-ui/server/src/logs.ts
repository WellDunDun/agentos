// Captures runtime output from deployed app VMs into the app's SQLite log
// table. The agentOS Apps replica actor broadcasts guest stdout/stderr as
// "processOutput" events; we subscribe to every replica we observe serving an
// app (via the x-agentos-app-replica response header) and bulk-write lines to
// the builderApp actor.
import type { client } from "./client.js";

interface ReplicaSubscription {
	dispose(): Promise<void> | void;
}

const decoder = new TextDecoder();

function decodeChunk(data: unknown): string {
	if (typeof data === "string") return data;
	if (data instanceof Uint8Array) return decoder.decode(data);
	if (data instanceof ArrayBuffer) return decoder.decode(new Uint8Array(data));
	if (Array.isArray(data)) return decoder.decode(Uint8Array.from(data));
	return String(data);
}

export class LogCollector {
	#client: typeof client;
	#subscriptions = new Map<string, Map<string, ReplicaSubscription>>();

	constructor(rivetClient: typeof client) {
		this.#client = rivetClient;
	}

	/**
	 * Subscribe to a replica identified by the x-agentos-app-replica response
	 * header ("appId/release/region/index"). Idempotent per replica.
	 */
	track(appId: string, replicaHeader: string): void {
		const key = replicaHeader.split("/");
		if (key.length < 4 || key[0] !== appId) return;
		let perApp = this.#subscriptions.get(appId);
		if (!perApp) {
			perApp = new Map();
			this.#subscriptions.set(appId, perApp);
		}
		if (perApp.has(replicaHeader)) return;

		const handle = (
			this.#client as unknown as {
				agentOSAppsReplica: {
					getOrCreate(key: string[]): {
						connect(): {
							on(event: string, cb: (data: unknown) => void): void;
							dispose(): Promise<void>;
						};
					};
				};
			}
		).agentOSAppsReplica.getOrCreate(key);
		const conn = handle.connect();
		const buffers = { stdout: "", stderr: "" };
		conn.on("processOutput", (payload) => {
			const { stream, data } = payload as { stream: string; data: unknown };
			const target = stream === "stderr" ? "stderr" : "stdout";
			buffers[target] += decodeChunk(data);
			const lines: { stream: string; line: string }[] = [];
			for (;;) {
				const newline = buffers[target].indexOf("\n");
				if (newline < 0) break;
				const line = buffers[target].slice(0, newline);
				buffers[target] = buffers[target].slice(newline + 1);
				if (line.trim().length > 0) lines.push({ stream: target, line });
			}
			if (lines.length > 0) {
				this.#client.builderApp
					.getOrCreate([appId])
					.appendLogs(lines)
					.catch((error) => {
						console.error("[builder] failed to persist app logs", error);
					});
			}
		});
		conn.on("processExit", (payload) => {
			const { exitCode } = payload as { exitCode: number };
			this.#client.builderApp
				.getOrCreate([appId])
				.appendLogs([
					{ stream: "system", line: `app process exited with code ${exitCode}` },
				])
				.catch((error) => {
					console.error("[builder] failed to persist app exit", error);
				});
		});
		perApp.set(replicaHeader, {
			dispose: () => conn.dispose(),
		});
	}

	/** Drop subscriptions for replicas of releases that are no longer serving. */
	async pruneApp(appId: string, keepHeaderPrefix?: string): Promise<void> {
		const perApp = this.#subscriptions.get(appId);
		if (!perApp) return;
		for (const [header, subscription] of perApp) {
			if (keepHeaderPrefix && header.startsWith(keepHeaderPrefix)) continue;
			perApp.delete(header);
			try {
				await subscription.dispose();
			} catch (error) {
				console.error("[builder] failed to dispose log subscription", error);
			}
		}
	}
}
