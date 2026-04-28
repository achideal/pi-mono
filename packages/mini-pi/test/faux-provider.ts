/**
 * test/faux-provider.ts — 可脚本化的假 LLM。
 *
 * 【教学要点】
 * 因为 provider 是一个函数类型（StreamFn），我们不需要任何 mocking 框架 ——
 * 一个 async generator 就是一个 provider。
 *
 * 这个文件的存在本身就是对"provider 作为函数类型"这一设计决策的**验证**：
 * 如果 provider 是某个 class / SDK 实例，mock 起来会复杂得多。
 */

import type { Message, StreamEvent, StreamFn, ToolCall, ToolSchema } from "../src/ai/index.js";

/** 预定义一个场景：一连串 yield 出来的事件。 */
export interface FauxScenario {
	/** 调用返回的事件序列。 */
	events: StreamEvent[];
}

/**
 * 顺序消费多个场景：第 N 次调用返回第 N 个场景。
 * 超出范围的调用会 throw，帮助测试发现意料外的额外调用。
 */
export function createFauxProvider(scenarios: FauxScenario[]): {
	streamFn: StreamFn;
	callCount: () => number;
	lastMessages: () => Message[];
	lastTools: () => ToolSchema[];
} {
	let index = 0;
	let lastMessages: Message[] = [];
	let lastTools: ToolSchema[] = [];

	const streamFn: StreamFn = async function* (messages, tools) {
		lastMessages = messages;
		lastTools = tools;
		const scenario = scenarios[index++];
		if (!scenario) throw new Error(`Unexpected call #${index} to faux provider`);
		for (const ev of scenario.events) {
			yield ev;
		}
	};

	return {
		streamFn,
		callCount: () => index,
		lastMessages: () => lastMessages,
		lastTools: () => lastTools,
	};
}

// ============================================================
// 便捷构造器
// ============================================================

export function textReply(text: string): FauxScenario {
	return {
		events: [
			{ type: "text_delta", text },
			{ type: "done", stopReason: "stop" },
		],
	};
}

export function toolCallReply(call: ToolCall): FauxScenario {
	return {
		events: [
			{ type: "tool_call", call },
			{ type: "done", stopReason: "tool_use" },
		],
	};
}

export function errorReply(message: string): FauxScenario {
	return {
		events: [{ type: "done", stopReason: "error", error: message }],
	};
}
