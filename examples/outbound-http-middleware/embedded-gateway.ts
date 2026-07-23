import { AgentOs } from "@rivet-dev/agentos-core";

const vm = await AgentOs.create({
	permissions: { network: "allow" },
	outboundByHost: {
		"api.openai.com": async (request) => {
			// Step 1: send the provider-shaped request to a trusted local gateway.
			const gatewayRequest: RequestInit & { duplex: "half" } = {
				method: request.method,
				headers: request.headers,
				body: request.body,
				duplex: "half",
			};
			const gatewayResponse = await fetch(
				"http://127.0.0.1:8787/v1/route",
				gatewayRequest,
			);

			// Step 2: return the gateway's provider-compatible response to the guest.
			return new Response(gatewayResponse.body, gatewayResponse);
		},
	},
});

await vm.dispose();
