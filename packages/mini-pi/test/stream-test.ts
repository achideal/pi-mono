import { loadConfiguredModel, stream, Type } from "../src/index.js";
import { clearDebugLog } from "./debug.js";

clearDebugLog();

const fakeToolParameters = Type.Object({
	query: Type.String(),
});

const model = loadConfiguredModel("openai-responses");
const s = stream(model, {
	systemPrompt: "这是一条测试消息，用于测试你是否有工具调用能力，请先讲个笑话，然后调用两次工具",
	messages: [
		{
			role: "user",
			content: "开始",
			timestamp: Date.now(),
		},
	],
	tools: [
		{
			name: "fake_lookup",
			description: "Look up fictional test data for the stream test.",
			parameters: fakeToolParameters,
		},
	],
});
let eventCount = 0;

for await (const event of s) {
	eventCount++;
	debug("event:", event.type, event);
}

const result = await s.result();
debug("result:", result);
debug("eventCount:", eventCount);
