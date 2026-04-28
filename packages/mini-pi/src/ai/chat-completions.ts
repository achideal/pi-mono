/**
 * ai/chat-completions.ts — OpenAI Chat Completions 协议适配器。
 *
 * 端点：POST {baseUrl}/chat/completions  (stream=true)
 *
 * 协议特点：
 * - 请求 body: { model, messages, tools, stream: true }
 * - 响应：SSE, 每个 chunk 形如
 *   { choices: [{ delta: { content?, tool_calls? }, finish_reason? }] }
 * - tool_calls 是**分片**推送的：
 *   第一片带 id + name + 空 arguments
 *   后续片只带 arguments 的 JSON 字符串增量
 *
 * 这个文件把以上协议翻译成归一化的 StreamEvent。
 */

import { parseSseStream } from "./sse.js";
import type { Message, StreamEvent, StreamFn, ToolCall, ToolSchema } from "./types.js";

// ============================================================
// 归一化 → OpenAI Chat Completions 请求格式
// ============================================================

interface ChatCompletionsMessage {
	role: "system" | "user" | "assistant" | "tool";
	content: string | null;
	tool_calls?: Array<{
		id: string;
		type: "function";
		function: { name: string; arguments: string };
	}>;
	tool_call_id?: string;
}

interface ChatCompletionsToolSpec {
	type: "function";
	function: {
		name: string;
		description: string;
		parameters: {
			type: "object";
			properties: Record<string, { type: string; description: string }>;
			required: string[];
		};
	};
}

function convertMessage(m: Message): ChatCompletionsMessage {
	switch (m.role) {
		case "system":
			return { role: "system", content: m.content };
		case "user":
			return { role: "user", content: m.content };
		case "assistant":
			return {
				role: "assistant",
				content: m.content || null,
				tool_calls: m.toolCalls?.map((tc) => ({
					id: tc.id,
					type: "function" as const,
					function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
				})),
			};
		case "tool":
			return { role: "tool", content: m.content, tool_call_id: m.toolCallId };
	}
}

function toChatMessages(messages: Message[]): ChatCompletionsMessage[] {
	return messages.map(convertMessage);
}

function toChatTools(tools: ToolSchema[]): ChatCompletionsToolSpec[] {
	return tools.map((t) => ({
		type: "function",
		function: {
			name: t.name,
			description: t.description,
			parameters: {
				type: "object",
				properties: Object.fromEntries(
					Object.entries(t.parameters).map(([k, v]) => [k, { type: v.type, description: v.description }]),
				),
				required: t.required,
			},
		},
	}));
}

// ============================================================
// 响应 chunk 类型（只声明我们会用到的字段）
// ============================================================

interface ChatCompletionsChunk {
	choices?: Array<{
		delta?: {
			content?: string | null;
			tool_calls?: Array<{
				index: number;
				id?: string;
				function?: { name?: string; arguments?: string };
			}>;
		};
		finish_reason?: string | null;
	}>;
}

// ============================================================
// streamFn 实现
// ============================================================

export const streamChatCompletions: StreamFn = async function* streamChatCompletions(messages, tools, options) {
	const baseUrl = options.baseUrl ?? "https://api.openai.com/v1";
	const url = `${baseUrl.replace(/\/$/, "")}/chat/completions`;

	const body = {
		model: options.model,
		messages: toChatMessages(messages),
		tools: tools.length > 0 ? toChatTools(tools) : undefined,
		stream: true,
	};

	let response: Response;
	try {
		response = await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${options.apiKey}`,
			},
			body: JSON.stringify(body),
			signal: options.signal,
		});
	} catch (err) {
		const aborted = (err as { name?: string }).name === "AbortError";
		yield { type: "done", stopReason: aborted ? "aborted" : "error", error: aborted ? undefined : String(err) };
		return;
	}

	// 跨 chunk 累积的 tool_calls（由 index 索引）
	const toolBuffer = new Map<number, { id: string; name: string; argsJson: string }>();
	let finishReason: string | null = null;

	try {
		for await (const raw of parseSseStream(response, options.signal)) {
			const chunk = raw as ChatCompletionsChunk;
			const choice = chunk.choices?.[0];
			if (!choice) continue;

			const delta = choice.delta;
			if (delta?.content) {
				yield { type: "text_delta", text: delta.content };
			}

			if (delta?.tool_calls) {
				for (const tc of delta.tool_calls) {
					const idx = tc.index;
					const buf = toolBuffer.get(idx) ?? { id: "", name: "", argsJson: "" };
					if (tc.id) buf.id = tc.id;
					if (tc.function?.name) buf.name = tc.function.name;
					if (tc.function?.arguments) buf.argsJson += tc.function.arguments;
					toolBuffer.set(idx, buf);
				}
			}

			if (choice.finish_reason) {
				finishReason = choice.finish_reason;
			}
		}
	} catch (err) {
		const aborted = (err as { name?: string }).name === "AbortError" || options.signal?.aborted;
		yield { type: "done", stopReason: aborted ? "aborted" : "error", error: aborted ? undefined : String(err) };
		return;
	}

	// 流结束：把累积的 tool_calls 整条发出（在 done 之前）
	for (const buf of toolBuffer.values()) {
		let args: Record<string, unknown> = {};
		if (buf.argsJson) {
			try {
				args = JSON.parse(buf.argsJson) as Record<string, unknown>;
			} catch {
				// 容错：参数 JSON 解析失败仍然发 tool_call，让 agent-loop 去处理
			}
		}
		const call: ToolCall = { id: buf.id, name: buf.name, arguments: args };
		yield { type: "tool_call", call };
	}

	const stopReason: StreamEvent = (() => {
		if (options.signal?.aborted) return { type: "done", stopReason: "aborted" };
		if (finishReason === "tool_calls") return { type: "done", stopReason: "tool_use" };
		return { type: "done", stopReason: "stop" };
	})();
	yield stopReason;
};
