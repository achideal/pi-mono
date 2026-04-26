import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { agentLoop, agentLoopContinue } from "../src/mini-pi-agent/agent-loop.js";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentTool } from "../src/mini-pi-agent/types.js";
import type { AssistantMessage, Message, Model, UserMessage } from "../src/mini-pi-ai/types.js";
import { createAssistantMessageEventStream } from "../src/mini-pi-ai/utils/event-stream.js";

function createModel(): Model {
	return {
		id: "mock-model",
		name: "mock-model",
		api: "openai-responses",
		provider: "openai-compatible",
		baseUrl: "https://example.invalid/v1",
		endpointUrl: "https://example.invalid/v1/responses",
		reasoning: true,
		input: ["text"],
		maxTokens: 4096,
	};
}

function createAssistantMessage(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai-compatible",
		model: "mock-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0,
			},
		},
		stopReason,
		timestamp: Date.now(),
	};
}

function createUserMessage(text: string): UserMessage {
	return {
		role: "user",
		content: text,
		timestamp: Date.now(),
	};
}

function emitDone(message: AssistantMessage) {
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() => {
		const reason = message.stopReason === "toolUse" ? "toolUse" : message.stopReason === "length" ? "length" : "stop";
		stream.push({ type: "done", reason, message });
	});
	return stream;
}

describe("mini-pi agentLoop", () => {
	it("emits prompt and assistant lifecycle events", async () => {
		const context: AgentContext = {
			systemPrompt: "You are helpful.",
			messages: [],
			tools: [],
		};

		const config: AgentLoopConfig = {
			model: createModel(),
		};

		const prompt = createUserMessage("hello");
		const events: AgentEvent[] = [];
		const stream = agentLoop([prompt], context, config, undefined, () =>
			emitDone(createAssistantMessage([{ type: "text", text: "hi" }])),
		);

		for await (const event of stream) {
			events.push(event);
		}

		const messages = await stream.result();
		expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
		expect(events.map((event) => event.type)).toEqual([
			"agent_start",
			"turn_start",
			"message_start",
			"message_end",
			"message_start",
			"message_end",
			"turn_end",
			"agent_end",
		]);
	});

	it("validates tool arguments, executes tools sequentially, and continues with tool results", async () => {
		const toolSchema = Type.Object({ count: Type.Number() });
		const executedArgs: number[] = [];
		const tool: AgentTool<typeof toolSchema, { count: number }> = {
			name: "echo",
			description: "Echo the count.",
			parameters: toolSchema,
			async execute(_toolCallId, params, _signal, onUpdate) {
				onUpdate?.({
					content: [{ type: "text", text: "working" }],
					details: { count: params.count },
				});
				executedArgs.push(params.count);
				return {
					content: [{ type: "text", text: `count:${params.count}` }],
					details: { count: params.count },
				};
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [tool],
		};

		const config: AgentLoopConfig = {
			model: createModel(),
		};

		let invocation = 0;
		const capturedContexts: Message[][] = [];
		const events: AgentEvent[] = [];
		const stream = agentLoop([createUserMessage("count")], context, config, undefined, (_model, streamContext) => {
			capturedContexts.push(streamContext.messages.map((message) => structuredClone(message)));
			invocation += 1;
			if (invocation === 1) {
				return emitDone(
					createAssistantMessage(
						[{ type: "toolCall", id: "tool-1", name: "echo", arguments: { count: "2" } }],
						"toolUse",
					),
				);
			}
			return emitDone(createAssistantMessage([{ type: "text", text: "done" }]));
		});

		for await (const event of stream) {
			events.push(event);
		}

		expect(executedArgs).toEqual([2]);
		expect(invocation).toBe(2);
		expect(capturedContexts[1]?.some((message) => message.role === "toolResult" && message.isError === false)).toBe(
			true,
		);
		expect(
			events.some(
				(event) =>
					event.type === "tool_execution_update" &&
					event.toolCallId === "tool-1" &&
					event.partialResult.content[0]?.text === "working",
			),
		).toBe(true);
	});

	it("creates an error tool result when validation fails", async () => {
		const toolSchema = Type.Object({ count: Type.Number() });
		const tool: AgentTool<typeof toolSchema> = {
			name: "echo",
			description: "Echo the count.",
			parameters: toolSchema,
			async execute() {
				throw new Error("should not run");
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [tool],
		};

		const config: AgentLoopConfig = {
			model: createModel(),
		};

		let invocation = 0;
		const stream = agentLoop([createUserMessage("count")], context, config, undefined, () => {
			invocation += 1;
			if (invocation === 1) {
				return emitDone(
					createAssistantMessage(
						[{ type: "toolCall", id: "tool-1", name: "echo", arguments: { count: "nope" } }],
						"toolUse",
					),
				);
			}
			return emitDone(createAssistantMessage([{ type: "text", text: "done" }]));
		});

		const events: AgentEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}

		const toolResultEvent = events.find(
			(event): event is Extract<AgentEvent, { type: "message_end" }> =>
				event.type === "message_end" && event.message.role === "toolResult",
		);
		expect(toolResultEvent?.message.role).toBe("toolResult");
		if (toolResultEvent?.message.role === "toolResult") {
			expect(toolResultEvent.message.isError).toBe(true);
			expect(toolResultEvent.message.content[0]?.text).toContain('Validation failed for tool "echo".');
		}
	});
});

describe("mini-pi agentLoopContinue", () => {
	it("continues from existing non-assistant context", async () => {
		const context: AgentContext = {
			systemPrompt: "",
			messages: [createUserMessage("hello")],
			tools: [],
		};

		const config: AgentLoopConfig = {
			model: createModel(),
		};

		const stream = agentLoopContinue(context, config, undefined, () =>
			emitDone(createAssistantMessage([{ type: "text", text: "continued" }])),
		);

		for await (const _event of stream) {
			// consume
		}

		const messages = await stream.result();
		expect(messages).toHaveLength(1);
		expect(messages[0]?.role).toBe("assistant");
	});

	it("rejects continue when the last message is assistant", () => {
		const context: AgentContext = {
			systemPrompt: "",
			messages: [createUserMessage("hello"), createAssistantMessage([{ type: "text", text: "done" }])],
			tools: [],
		};

		const config: AgentLoopConfig = {
			model: createModel(),
		};

		expect(() => agentLoopContinue(context, config)).toThrow("Cannot continue from message role: assistant");
	});
});
