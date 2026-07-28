import { createClient } from "rivetkit/client";
import type { registry } from "./actors.js";

/** RivetKit client for the host registry (builder actors + apps actors). */
export const client = createClient<typeof registry>({
	endpoint: process.env.RIVET_ENGINE ?? process.env.RIVET_ENDPOINT ?? "http://localhost:6420",
});
