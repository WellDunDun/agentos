import { AgentOs } from "@rivet-dev/agentos-core";

const vm = await AgentOs.create({
	permissions: { network: "allow" },
	outbound: (request) => fetch(request),
});

// Guest fetch() and node:http requests enter `outbound` before host egress.
await vm.dispose();
