/**
 * test/agent-loop.test.ts — 只测内核（证明内核可脱离外壳存在）。
 */

import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../src/agent/index.js";
import { runAgentLoop } from "../src/agent/index.js";
import type { Tool } from "../src/tools/index.js";
import { createFauxProvider, textReply, toolCallReply } from "./faux-provider.js";

const emptyContext = () => ({
	systemPrompt: "You are a test agent.",
	messages: [],
	tools: [] as Tool[],
});

function collectEvents() {
	const events: AgentEvent[] = [];
	return { emit: async (e: AgentEvent) => void events.push(e), events };
}

describe("runAgentLoop", () => {
	it("produces a stop reason when LLM returns plain text", async () => {
		const faux = createFauxProvider([textReply("Hello!")]);
		const { emit, events } = collectEvents();

		const newMessages = await runAgentLoop(
			[{ role: "user", content: "hi" }],
			emptyContext(),
			{ model: "test", apiKey: "test", streamFn: faux.streamFn },
			emit,
		);

		expect(faux.callCount()).toBe(1);
		// newMessages: user + assistant
		expect(newMessages).toHaveLength(2);
		expect(newMessages[0]).toEqual({ role: "user", content: "hi" });
		expect(newMessages[1].role).toBe("assistant");
		expect(newMessages[1].role === "assistant" && newMessages[1].content).toBe("Hello!");

		// 事件顺序关键点
		const types = events.map((e) => e.type);
		expect(types).toContain("agent_start");
		expect(types).toContain("message_end");
		expect(types[types.length - 1]).toBe("agent_end");
		expect(events.at(-1)).toMatchObject({ type: "agent_end", reason: "stop" });
	});

	it("executes a tool call and feeds result back for a second turn", async () => {
		const echoTool: Tool<{ msg: string }> = {
			schema: {
				name: "echo",
				description: "echoes msg",
				parameters: { msg: { type: "string", description: "text" } },
				required: ["msg"],
			},
			execute: async (args) => ({ output: `echoed:${args.msg}` }),
		};

		const faux = createFauxProvider([
			toolCallReply({ id: "c1", name: "echo", arguments: { msg: "hi" } }),
			textReply("Got it."),
		]);
		const { emit, events } = collectEvents();

		const newMessages = await runAgentLoop(
			[{ role: "user", content: "do it" }],
			{ systemPrompt: "", messages: [], tools: [echoTool as Tool] },
			{ model: "test", apiKey: "test", streamFn: faux.streamFn },
			emit,
		);

		expect(faux.callCount()).toBe(2);
		// user + assistant(with toolCall) + toolResult + assistant(final text)
		expect(newMessages).toHaveLength(4);
		expect(newMessages[1].role).toBe("assistant");
		expect(newMessages[2].role).toBe("tool");
		expect(newMessages[2].role === "tool" && newMessages[2].content).toBe("echoed:hi");

		// 第二次调 LLM 时，messages 里必须包含 tool result
		const secondCall = faux.lastMessages();
		expect(secondCall.some((m) => m.role === "tool")).toBe(true);

		// 事件检查
		expect(events.some((e) => e.type === "tool_start")).toBe(true);
		expect(events.some((e) => e.type === "tool_end")).toBe(true);
	});

	it("stops with error reason when the tool is not found", async () => {
		// LLM 调了一个不存在的工具；loop 应返回错误 tool_result 并重新让 LLM 回应
		const faux = createFauxProvider([
			toolCallReply({ id: "c1", name: "does_not_exist", arguments: {} }),
			textReply("Sorry, I couldn't do that."),
		]);
		const { emit } = collectEvents();

		const newMessages = await runAgentLoop(
			[{ role: "user", content: "go" }],
			emptyContext(),
			{ model: "test", apiKey: "test", streamFn: faux.streamFn },
			emit,
		);

		// 应有一条 tool error 结果
		const toolResult = newMessages.find((m) => m.role === "tool");
		expect(toolResult?.role === "tool" && toolResult.content).toContain("Tool not found");
	});

	it("respects maxTurns", async () => {
		// 连续返回 tool_use，能触发 max_turns
		const forever: Parameters<typeof createFauxProvider>[0] = Array.from({ length: 10 }, () =>
			toolCallReply({ id: `c${Math.random()}`, name: "nope", arguments: {} }),
		);
		const faux = createFauxProvider(forever);
		const { emit, events } = collectEvents();

		await runAgentLoop(
			[{ role: "user", content: "loop" }],
			emptyContext(),
			{ model: "test", apiKey: "test", streamFn: faux.streamFn, maxTurns: 3 },
			emit,
		);

		expect(events.at(-1)).toMatchObject({ type: "agent_end", reason: "max_turns" });
	});
});
