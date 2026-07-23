import { AgentOs } from "@rivet-dev/agentos-core";

const encoder = new TextEncoder();
const vm = await AgentOs.create({
	permissions: { network: "allow" },
	outboundByHost: {
		"api.openai.com": () =>
			new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(
							encoder.encode(
								'data: {"type":"response.output_text.delta","delta":"Hello"}\n\n',
							),
						);
						controller.enqueue(encoder.encode("data: [DONE]\n\n"));
						controller.close();
					},
				}),
				{ headers: { "content-type": "text/event-stream" } },
			),
	},
});

await vm.dispose();
