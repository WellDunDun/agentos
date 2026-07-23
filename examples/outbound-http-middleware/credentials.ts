import { AgentOs } from "@rivet-dev/agentos-core";

const vm = await AgentOs.create({
	permissions: { network: "allow" },
	outboundByHost: {
		"api.example.com": (request) => {
			const headers = new Headers(request.headers);
			headers.set("authorization", `Bearer ${process.env.PROVIDER_API_KEY}`);
			return fetch(new Request(request, { headers }));
		},
	},
});

await vm.dispose();
