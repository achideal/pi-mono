import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { MiniAgent } from "../src/mini-pi-agent/agent.js";
import type { AgentEvent } from "../src/mini-pi-agent/types.js";
import type { AssistantMessage, Model } from "../src/mini-pi-ai/types.js";
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
	text: string,
	stopReason: AssistantMessage["stopReason"] = "stop",
	errorMessage?: string,
): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
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
		errorMessage,
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

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve = () => {};
	const promise = new Promise<void>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

describe("MiniAgent", () => {
	it("stores prompt and assistant messages in state", async () => {
		const agent = new MiniAgent({
			initialState: {
				model: createModel(),
			},
			streamFn: () => emitDone(createAssistantMessage("hi")),
		});

		await agent.prompt("hello");

		expect(agent.state.messages).toHaveLength(2);
		expect(agent.state.messages[0]?.role).toBe("user");
		expect(agent.state.messages[1]?.role).toBe("assistant");
		expect(agent.state.isStreaming).toBe(false);
	});

	it("waits for async subscribers before prompt resolves", async () => {
		const barrier = createDeferred();
		const agent = new MiniAgent({
			initialState: {
				model: createModel(),
			},
			streamFn: () => emitDone(createAssistantMessage("hi")),
		});

		let promptResolved = false;
		agent.subscribe(async (event) => {
			if (event.type === "agent_end") {
				await barrier.promise;
			}
		});

		const promptPromise = agent.prompt("hello").then(() => {
			promptResolved = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(promptResolved).toBe(false);
		expect(agent.state.isStreaming).toBe(true);

		barrier.resolve();
		await promptPromise;
		expect(agent.state.isStreaming).toBe(false);
	});

	it("tracks pending tool calls and clears them after completion", async () => {
		const events: AgentEvent[] = [];
		const agent = new MiniAgent({
			initialState: {
				model: createModel(),
			},
		});

		agent.state.tools = [
			{
				name: "echo",
				description: "Echo a value.",
				parameters: Type.Object({}),
				async execute(_toolCallId, _params, _signal, onUpdate) {
					onUpdate?.({
						content: [{ type: "text", text: "working" }],
						details: { ok: true },
					});
					return {
						content: [{ type: "text", text: "ok" }],
						details: { ok: true },
					};
				},
			},
		];

		agent.subscribe((event) => {
			events.push(event);
		});

		agent.streamFn = (() => {
			let invocation = 0;
			return () => {
				invocation += 1;
				if (invocation === 1) {
					const stream = createAssistantMessageEventStream();
					queueMicrotask(() => {
						stream.push({
							type: "done",
							reason: "toolUse",
							message: {
								...createAssistantMessage("", "toolUse"),
								content: [{ type: "toolCall", id: "tool-1", name: "echo", arguments: {} }],
							},
						});
					});
					return stream;
				}
				return emitDone(createAssistantMessage("done"));
			};
		})();

		await agent.prompt("hello");

		expect(events.some((event) => event.type === "tool_execution_start" && event.toolCallId === "tool-1")).toBe(true);
		expect(events.some((event) => event.type === "tool_execution_end" && event.toolCallId === "tool-1")).toBe(true);
		expect(agent.state.pendingToolCalls.size).toBe(0);
	});

	it("captures aborted assistant errors", async () => {
		const agent = new MiniAgent({
			initialState: {
				model: createModel(),
			},
			streamFn: (_model, _context, options) => {
				const stream = createAssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: createAssistantMessage("") });
					const poll = () => {
						if (options?.signal?.aborted) {
							stream.push({
								type: "error",
								reason: "aborted",
								error: createAssistantMessage("", "aborted", "aborted"),
							});
							return;
						}
						setTimeout(poll, 5);
					};
					poll();
				});
				return stream;
			},
		});

		const promptPromise = agent.prompt("hello");
		await new Promise((resolve) => setTimeout(resolve, 15));
		agent.abort();
		await promptPromise;

		expect(agent.state.errorMessage).toBe("aborted");
		const lastMessage = agent.state.messages.at(-1);
		expect(lastMessage?.role).toBe("assistant");
		if (lastMessage?.role === "assistant") {
			expect(lastMessage.stopReason).toBe("aborted");
		}
	});

	it("rejects continue from assistant tail", async () => {
		const agent = new MiniAgent({
			initialState: {
				model: createModel(),
			},
			streamFn: () => emitDone(createAssistantMessage("hi")),
		});

		await agent.prompt("hello");
		await expect(agent.continue()).rejects.toThrow("Cannot continue from message role: assistant");
	});
});
