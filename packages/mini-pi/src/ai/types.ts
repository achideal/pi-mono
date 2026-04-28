/**
 * ai/types.ts — LLM 调用的归一化契约。
 *
 * 【教学要点】
 * 1. Message / ToolCall / StreamEvent 是 provider-agnostic 的 —— 不绑定任何 SDK。
 * 2. `StreamFn` 把 provider 抽象成**一个函数类型**，这是 DI 最简洁的形式：
 *    "把能力本身当参数传"，而不是"传一个实现了某接口的对象"。
 * 3. 本层不依赖任何其他 mini-pi 模块 —— ai 层是"叶子能力"。
 */

// ============================================================
// 消息类型（与 provider 解耦）
// ============================================================

export interface TextContent {
	type: "text";
	text: string;
}

export interface ToolCall {
	id: string;
	name: string;
	/** JSON 对象形式的参数。校验在 agent-loop 里做。 */
	arguments: Record<string, unknown>;
}

export interface SystemMessage {
	role: "system";
	content: string;
}

export interface UserMessage {
	role: "user";
	content: string;
}

export interface AssistantMessage {
	role: "assistant";
	/** 文本内容；如果只有 toolCalls 没有文本，可以为空串。 */
	content: string;
	toolCalls?: ToolCall[];
}

export interface ToolResultMessage {
	role: "tool";
	toolCallId: string;
	content: string;
}

export type Message = SystemMessage | UserMessage | AssistantMessage | ToolResultMessage;

// ============================================================
// 工具 Schema（传给 LLM 的工具描述，不是工具本身）
// ============================================================

export interface ToolParameter {
	type: "string" | "number" | "boolean";
	description: string;
}

export interface ToolSchema {
	name: string;
	description: string;
	parameters: Record<string, ToolParameter>;
	required: string[];
}

// ============================================================
// 流式事件（provider 层的抽象输出）
// ============================================================

export type StreamEvent =
	| { type: "text_delta"; text: string }
	| { type: "tool_call"; call: ToolCall }
	| { type: "done"; stopReason: StopReason; error?: string };

export type StopReason = "stop" | "tool_use" | "aborted" | "error";

// ============================================================
// StreamFn：LLM 调用的最小契约
// ============================================================

export interface StreamOptions {
	apiKey: string;
	model: string;
	baseUrl?: string;
	signal?: AbortSignal;
}

/**
 * 所有 provider 都实现这个类型。
 *
 * 设计意图：
 * - 不是 class，不是接口对象 —— 是**函数类型**。这让 provider 既可以是顶层函数，
 *   也可以是闭包、也可以是 mock —— 调用方只关心"我能不能拿到 StreamEvent 流"。
 * - 输入是**归一化的** Message[] 和 ToolSchema[]，provider 内部负责转成 SDK 原生格式。
 * - 输出是 AsyncIterable<StreamEvent>，天然支持 for-await-of 和 AbortSignal。
 */
export type StreamFn = (messages: Message[], tools: ToolSchema[], options: StreamOptions) => AsyncIterable<StreamEvent>;
