import { actor, setup } from "rivetkit";
import { createClient } from "rivetkit/client";
import { db } from "rivetkit/db";

const notes = actor({
	db: db({
		async onMigrate(database) {
			await database.execute(`
				CREATE TABLE IF NOT EXISTS notes (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					body TEXT NOT NULL
				)
			`);
		},
	}),
	actions: {
		async add(c, body: string) {
			await c.db.execute("INSERT INTO notes (body) VALUES (?)", body);
		},
		async list(c) {
			return c.db.execute("SELECT id, body FROM notes ORDER BY id");
		},
	},
});

export const registry = setup({
	use: { notes },
});

registry.start();

const client = createClient<typeof registry>();

export default async function fetch() {
	const scopedNotes = client.notes.getOrCreate(["http-handler"]);
	await scopedNotes.add("written from the guest HTTP handler");
	const rows = (await scopedNotes.list()) as Array<{
		id: number;
		body: string;
	}>;
	return Response.json({
		app: "sqlite-notes",
		message: "The guest used its scoped RivetKit client.",
		scopedActorRows: rows.length,
		lastScopedActorBody: rows.at(-1)?.body,
	});
}
