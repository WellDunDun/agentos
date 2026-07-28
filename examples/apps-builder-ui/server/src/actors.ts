import { setup } from "@rivet-dev/agentos";
import { setupApps } from "@rivet-dev/agentos-apps";
import { actor } from "rivetkit";
import { db } from "rivetkit/db";
import type { AppStatus, Block, ChatMessage } from "./types.js";

const { appsActors } = setupApps();

const MAX_LOG_ROWS = 2000;

/** Singleton index of builder apps, backing the landing screen. */
const builderDirectory = actor({
	db: db({
		async onMigrate(database) {
			await database.execute(`
				CREATE TABLE IF NOT EXISTS apps (
					id TEXT PRIMARY KEY,
					name TEXT NOT NULL,
					status TEXT NOT NULL,
					release_number INTEGER NOT NULL,
					prompt TEXT NOT NULL,
					updated_at INTEGER NOT NULL
				) STRICT
			`);
		},
	}),
	actions: {
		async list(c) {
			const rows = await c.db.execute(
				"SELECT id, name, status, release_number, prompt, updated_at FROM apps ORDER BY updated_at DESC",
			);
			return rows.map((r) => ({
				id: r.id as string,
				name: r.name as string,
				status: r.status as AppStatus,
				release: r.release_number as number,
				prompt: r.prompt as string,
				updatedAt: r.updated_at as number,
			}));
		},
		async create(c, app: { id: string; name: string; prompt: string }) {
			await c.db.execute(
				"INSERT INTO apps (id, name, status, release_number, prompt, updated_at) VALUES (?, ?, 'building', 0, ?, ?)",
				app.id,
				app.name,
				app.prompt,
				Date.now(),
			);
		},
		async setStatus(c, id: string, status: AppStatus, release?: number) {
			if (release === undefined) {
				await c.db.execute(
					"UPDATE apps SET status = ?, updated_at = ? WHERE id = ?",
					status,
					Date.now(),
					id,
				);
			} else {
				await c.db.execute(
					"UPDATE apps SET status = ?, release_number = ?, updated_at = ? WHERE id = ?",
					status,
					release,
					Date.now(),
					id,
				);
			}
		},
	},
});

/** Per-app builder state: chat history, staged files, runtime logs. */
const builderApp = actor({
	db: db({
		async onMigrate(database) {
			await database.execute(`
				CREATE TABLE IF NOT EXISTS meta (
					key TEXT PRIMARY KEY,
					value TEXT NOT NULL
				) STRICT
			`);
			await database.execute(`
				CREATE TABLE IF NOT EXISTS messages (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					role TEXT NOT NULL,
					text TEXT,
					blocks TEXT,
					created_at INTEGER NOT NULL
				) STRICT
			`);
			await database.execute(`
				CREATE TABLE IF NOT EXISTS files (
					path TEXT PRIMARY KEY,
					content TEXT NOT NULL
				) STRICT
			`);
			await database.execute(`
				CREATE TABLE IF NOT EXISTS logs (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					ts INTEGER NOT NULL,
					stream TEXT NOT NULL,
					line TEXT NOT NULL
				) STRICT
			`);
		},
	}),
	actions: {
		async init(c, meta: { name: string; prompt: string }) {
			await c.db.execute(
				"INSERT OR REPLACE INTO meta (key, value) VALUES ('name', ?), ('prompt', ?), ('status', 'building'), ('release', '0'), ('pendingFirstPrompt', ?)",
				meta.name,
				meta.prompt,
				meta.prompt,
			);
		},
		async detail(c) {
			const metaRows = await c.db.execute("SELECT key, value FROM meta");
			const meta = Object.fromEntries(
				metaRows.map((r) => [r.key as string, r.value as string]),
			);
			const messageRows = await c.db.execute(
				"SELECT role, text, blocks FROM messages ORDER BY id",
			);
			const messages: ChatMessage[] = messageRows.map((r) =>
				r.role === "user"
					? { role: "user", text: r.text as string }
					: { role: "agent", blocks: JSON.parse((r.blocks as string) ?? "[]") },
			);
			const fileRows = await c.db.execute("SELECT path, content FROM files");
			const files = Object.fromEntries(
				fileRows.map((r) => [r.path as string, r.content as string]),
			);
			return {
				name: meta.name ?? c.key[0],
				prompt: meta.prompt ?? "",
				status: (meta.status ?? "building") as AppStatus,
				release: Number(meta.release ?? 0),
				messages,
				files,
			};
		},
		async takePendingFirstPrompt(c) {
			const rows = await c.db.execute(
				"SELECT value FROM meta WHERE key = 'pendingFirstPrompt'",
			);
			const prompt = rows[0]?.value as string | undefined;
			if (!prompt) return null;
			await c.db.execute("DELETE FROM meta WHERE key = 'pendingFirstPrompt'");
			return prompt;
		},
		/** Compare-and-set busy flag serializing agent runs per app. */
		async tryAcquireRun(c) {
			const rows = await c.db.execute(
				"SELECT value FROM meta WHERE key = 'busy'",
			);
			if (rows[0]?.value === "1") return false;
			await c.db.execute(
				"INSERT OR REPLACE INTO meta (key, value) VALUES ('busy', '1')",
			);
			return true;
		},
		async releaseRun(c) {
			await c.db.execute(
				"INSERT OR REPLACE INTO meta (key, value) VALUES ('busy', '0')",
			);
		},
		async appendUserMessage(c, text: string) {
			await c.db.execute(
				"INSERT INTO messages (role, text, created_at) VALUES ('user', ?, ?)",
				text,
				Date.now(),
			);
		},
		async appendAgentMessage(c, blocks: Block[]) {
			await c.db.execute(
				"INSERT INTO messages (role, blocks, created_at) VALUES ('agent', ?, ?)",
				JSON.stringify(blocks),
				Date.now(),
			);
		},
		async writeFiles(c, files: Record<string, string>) {
			for (const [path, content] of Object.entries(files)) {
				await c.db.execute(
					"INSERT OR REPLACE INTO files (path, content) VALUES (?, ?)",
					path,
					content,
				);
			}
		},
		async getFiles(c) {
			const rows = await c.db.execute("SELECT path, content FROM files");
			return Object.fromEntries(
				rows.map((r) => [r.path as string, r.content as string]),
			);
		},
		async setStatus(c, status: AppStatus, release?: number) {
			await c.db.execute(
				"INSERT OR REPLACE INTO meta (key, value) VALUES ('status', ?)",
				status,
			);
			if (release !== undefined) {
				await c.db.execute(
					"INSERT OR REPLACE INTO meta (key, value) VALUES ('release', ?)",
					String(release),
				);
			}
		},
		async appendLogs(c, entries: { stream: string; line: string }[]) {
			const now = Date.now();
			for (const entry of entries) {
				await c.db.execute(
					"INSERT INTO logs (ts, stream, line) VALUES (?, ?, ?)",
					now,
					entry.stream,
					entry.line.slice(0, 4096),
				);
			}
			// Bounded by default: keep only the most recent rows.
			await c.db.execute(
				"DELETE FROM logs WHERE id <= (SELECT MAX(id) FROM logs) - ?",
				MAX_LOG_ROWS,
			);
		},
		async readLogs(c, limit: number) {
			const bounded = Math.max(1, Math.min(limit, 500));
			const rows = await c.db.execute(
				"SELECT ts, stream, line FROM logs ORDER BY id DESC LIMIT ?",
				bounded,
			);
			return rows.reverse().map((r) => ({
				ts: r.ts as number,
				stream: r.stream as string,
				line: r.line as string,
			}));
		},
	},
});

export const registry = setup({
	use: {
		...appsActors,
		builderDirectory,
		builderApp,
	},
});
