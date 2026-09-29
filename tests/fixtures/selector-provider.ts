import { createAssistantMessageEventStream, type Api, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Both accounts terminate locally. Tests must never contact a provider.
export default function selectorProvider(pi: ExtensionAPI) {
	let calls = 0;
	const errors = JSON.parse(process.env.MULTI_PASS_TEST_ERRORS || "{}") as Record<string, string>;
	for (const id of ["anthropic", "anthropic-2"]) {
		const stream = (model: Model<Api>) => {
			const events = createAssistantMessageEventStream();
			const error = errors[String(++calls)];
			const message: AssistantMessage = {
				role: "assistant",
				content: error ? [] : [{ type: "text", text: `response from ${id}` }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: error ? "error" : "stop",
				errorMessage: error,
				timestamp: Date.now(),
			};
			queueMicrotask(() => {
				if (error) events.push({ type: "error", reason: "error", error: message });
				else events.push({ type: "done", reason: "stop", message });
			});
			return events;
		};
		pi.registerProvider({
			id,
			name: id,
			auth: { apiKey: { name: id, resolve: async () => ({ auth: { apiKey: "test" }, source: "fixture" }) } },
			getModels: () => getBuiltinModels("anthropic").map((model) => ({ ...model, provider: id })),
			stream,
			streamSimple: stream,
		});
	}
}
