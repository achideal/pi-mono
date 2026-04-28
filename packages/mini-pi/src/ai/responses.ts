/**
 * ai/responses.ts — OpenAI Responses API 协议适配器。
 *
 * 端点：POST {baseUrl}/responses  (stream=true)
 *
 * 协议特点（与 chat.completions 的差异）：
 * - 请求 body 结构不同：`input` 替代 `messages`，`input` 是"条目"数组
 *   - 每条消息是 { type: "message", role, content: [{ type: "input_text", text }] }
 *   - 工具结果是 { type: "function_call_output", call_id, output }
 *   - 过往 tool_call 是 { type: "function_call", call_id, name, arguments }
 * - 工具格式更扁平：`tools: [{ type: "function", name, description, parameters }]`
 * - 响应是"事件化"的 SSE，每个事件有 `type` 字段：
 *   - response.output_text.delta  →  文本增量
 *   - response.output_item.added   →  一条输出条目开始（可能是 function_call）
 *   - response.function_call_arguments.delta  →  工具参数增量
 *   - response.function_call_arguments.done   →  某个工具调用参数完成
 *   - response.completed / response.failed    →  终止
 *
 * 这个文件把以上协议翻译成归一化的 StreamEvent。
 */

import { parseSseStream } from "./sse.js";
import type { Message, StreamEvent, StreamFn, ToolCall, ToolSchema } from "./types.js";

// ============================================================
// 归一化 → Responses API 请求格式
// ============================================================

type ResponsesInputItem =
	| {
			type: "message";
			role: "system" | "user" | "assistant";
			content: Array<{ type: "input_text" | "output_text"; text: string }>;
	  }
	| {
			type: "function_call";
			call_id: string;
			name: string;
			arguments: string;
	  }
	| {
			type: "function_call_output";
			call_id: string;
			output: string;
	  };

interface ResponsesToolSpec {
	type: "function";
	name: string;
	description: string;
	parameters: {
		type: "object";
		properties: Record<string, { type: string; description: string }>;
		required: string[];
	};
}

function toResponsesInput(messages: Message[]): ResponsesInputItem[] {
	const items: ResponsesInputItem[] = [];
	for (const m of messages) {
		switch (m.role) {
			case "system":
				items.push({
					type: "message",
					role: "system",
					content: [{ type: "input_text", text: m.content }],
				});
				break;
			case "user":
				items.push({
					type: "message",
					role: "user",
					content: [{ type: "input_text", text: m.content }],
				});
				break;
			case "assistant":
				if (m.content) {
					items.push({
						type: "message",
						role: "assistant",
						content: [{ type: "output_text", text: m.content }],
					});
				}
				if (m.toolCalls) {
					for (const tc of m.toolCalls) {
						items.push({
							type: "function_call",
							call_id: tc.id,
							name: tc.name,
							arguments: JSON.stringify(tc.arguments),
						});
					}
				}
				break;
			case "tool":
				items.push({
					type: "function_call_output",
					call_id: m.toolCallId,
					output: m.content,
				});
				break;
		}
	}
	return items;
}

function toResponsesTools(tools: ToolSchema[]): ResponsesToolSpec[] {
	return tools.map((t) => ({
		type: "function",
		name: t.name,
		description: t.description,
		parameters: {
			type: "object",
			properties: Object.fromEntries(
				Object.entries(t.parameters).map(([k, v]) => [k, { type: v.type, description: v.description }]),
			),
			required: t.required,
		},
	}));
}

// ============================================================
// 响应事件类型（只声明我们关心的字段）
// ============================================================

interface ResponsesEventBase {
	type: string;
}

interface OutputTextDeltaEvent extends ResponsesEventBase {
	type: "response.output_text.delta";
	delta: string;
}

interface OutputItemAddedEvent extends ResponsesEventBase {
	type: "response.output_item.added";
	item?: {
		id?: string;
		type?: string;
		call_id?: string;
		name?: string;
		arguments?: string;
	};
}

interface FunctionCallArgsDeltaEvent extends ResponsesEventBase {
	type: "response.function_call_arguments.delta";
	item_id?: string;
	delta?: string;
}

interface FunctionCallArgsDoneEvent extends ResponsesEventBase {
	type: "response.function_call_arguments.done";
	item_id?: string;
	arguments?: string;
}

interface ResponseCompletedEvent extends ResponsesEventBase {
	type: "response.completed";
	response?: { status?: string };
}

interface ResponseFailedEvent extends ResponsesEventBase {
	type: "response.failed";
	response?: { error?: { message?: string } };
}

type AnyResponsesEvent =
	| OutputTextDeltaEvent
	| OutputItemAddedEvent
	| FunctionCallArgsDeltaEvent
	| FunctionCallArgsDoneEvent
	| ResponseCompletedEvent
	| ResponseFailedEvent
	| ResponsesEventBase;

// ============================================================
// streamFn 实现
// ============================================================

export const streamResponses: StreamFn = async function* streamResponses(messages, tools, options) {
	const baseUrl = options.baseUrl ?? "https://api.openai.com/v1";
	const url = `${baseUrl.replace(/\/$/, "")}/responses`;

	const body = {
		model: options.model,
		input: toResponsesInput(messages),
		tools: tools.length > 0 ? toResponsesTools(tools) : undefined,
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

	// item_id → 工具调用累积 buffer
	const toolBuffer = new Map<string, { id: string; name: string; argsJson: string }>();
	let hasToolUse = false;
	let errorMessage: string | null = null;

	try {
		for await (const raw of parseSseStream(response, options.signal)) {
			const ev = raw as AnyResponsesEvent;

			if (ev.type === "response.output_text.delta") {
				const e = ev as OutputTextDeltaEvent;
				if (e.delta) yield { type: "text_delta", text: e.delta };
				continue;
			}

			if (ev.type === "response.output_item.added") {
				const e = ev as OutputItemAddedEvent;
				if (e.item?.type === "function_call" && e.item.id) {
					toolBuffer.set(e.item.id, {
						id: e.item.call_id ?? e.item.id,
						name: e.item.name ?? "",
						argsJson: e.item.arguments ?? "",
					});
					hasToolUse = true;
				}
				continue;
			}

			if (ev.type === "response.function_call_arguments.delta") {
				const e = ev as FunctionCallArgsDeltaEvent;
				if (e.item_id && e.delta) {
					const buf = toolBuffer.get(e.item_id);
					if (buf) buf.argsJson += e.delta;
				}
				continue;
			}

			if (ev.type === "response.function_call_arguments.done") {
				const e = ev as FunctionCallArgsDoneEvent;
				if (e.item_id && typeof e.arguments === "string") {
					const buf = toolBuffer.get(e.item_id);
					if (buf) buf.argsJson = e.arguments;
				}
				continue;
			}

			if (ev.type === "response.failed") {
				const e = ev as ResponseFailedEvent;
				errorMessage = e.response?.error?.message ?? "Responses API failed";
				continue;
			}

			if (ev.type === "response.completed") {
			}
		}
	} catch (err) {
		const aborted = (err as { name?: string }).name === "AbortError" || options.signal?.aborted;
		yield { type: "done", stopReason: aborted ? "aborted" : "error", error: aborted ? undefined : String(err) };
		return;
	}

	// 发出所有累积的工具调用
	for (const buf of toolBuffer.values()) {
		let args: Record<string, unknown> = {};
		if (buf.argsJson) {
			try {
				args = JSON.parse(buf.argsJson) as Record<string, unknown>;
			} catch {
				// 保持空对象，交由 agent-loop 报错处理
			}
		}
		const call: ToolCall = { id: buf.id, name: buf.name, arguments: args };
		yield { type: "tool_call", call };
	}

	const finalEvent: StreamEvent = (() => {
		if (options.signal?.aborted) return { type: "done", stopReason: "aborted" };
		if (errorMessage) return { type: "done", stopReason: "error", error: errorMessage };
		if (hasToolUse) return { type: "done", stopReason: "tool_use" };
		return { type: "done", stopReason: "stop" };
	})();
	yield finalEvent;
};
