/**
 * agent/types.ts — Agent 外壳与 agent-loop 内核的接触面契约。
 *
 * 【教学要点】
 * 这个文件定义了三组契约：
 *  1. AgentContext  ：内核"看到"的会话快照（只读语义）
 *  2. AgentLoopConfig：外壳注入给内核的"策略 + 依赖"
 *  3. AgentEvent    ：内核发给外壳的事件（单向输出）
 *
 * 三组契约加起来，就是"外壳 ↔ 内核"的全部边界。除此之外没有别的通信通道。
 */

import type { Message, StreamFn, ToolCall } from "../ai/index.js";
import type { Tool, ToolResult } from "../tools/index.js";

// ============================================================
// 1. AgentContext — 传给内核的会话快照
// ============================================================

/**
 * 一次内核运行所需的会话状态。
 *
 * 注意：messages 会在 runLoop 内部被 push（追加助手回复和工具结果），
 *      所以这里用普通数组而不是 readonly —— 但外部调用方必须把它当作"交出去的一次性副本"，
 *      不应该在 loop 运行中读它。这是通过 Agent 外壳的"活跃运行锁"保证的。
 */
export interface AgentContext {
	systemPrompt: string;
	messages: Message[];
	tools: Tool[];
}

// ============================================================
// 2. AgentLoopConfig — 传给内核的"策略 + 依赖"
// ============================================================

export interface BeforeToolCallResult {
	/** 如果返回 block=true，工具不执行，直接给 LLM 一个错误 tool_result。 */
	block?: boolean;
	reason?: string;
}

export interface AgentLoopConfig {
	model: string;
	apiKey: string;
	baseUrl?: string;

	/** 注入的 LLM 调用函数 —— 这是 DI 的核心。 */
	streamFn: StreamFn;

	/** 工具执行前的拦截钩子（可选）。外壳可用于审批、日志、配额等。 */
	beforeToolCall?: (call: ToolCall) => Promise<BeforeToolCallResult | undefined> | BeforeToolCallResult | undefined;

	/** 工具执行后的拦截钩子（可选）。可以改写结果（例如截断、脱敏）。 */
	afterToolCall?: (call: ToolCall, result: ToolResult) => Promise<ToolResult> | ToolResult;

	/** 单次 loop 最多允许多少轮（防止 tool use 无限循环）。 */
	maxTurns?: number;
}

// ============================================================
// 3. AgentEvent — 内核发给外壳的事件
// ============================================================

/**
 * 内核要通知外壳的事件类型。所有状态变更都必须走事件。
 *
 * 语义约定：
 * - `message_start` 只标记"一个流式 assistant 输出即将开始"，之后会收到 text_delta / message_end(assistant)。
 *   user / tool-result 消息不是流式生成的，它们**只发 message_end**，不发 message_start。
 * - `message_end` 是"一条完整消息落地"的权威事件，外壳/UI/持久化都以此为准。
 */
export type AgentEvent =
	| { type: "agent_start" }
	| { type: "turn_start"; turn: number }
	| { type: "message_start" }
	| { type: "text_delta"; text: string }
	| { type: "message_end"; message: Message }
	| { type: "tool_start"; call: ToolCall }
	| { type: "tool_end"; callId: string; result: ToolResult }
	| { type: "turn_end"; turn: number }
	| { type: "agent_end"; reason: "stop" | "error" | "aborted" | "max_turns"; error?: string };

export type AgentEventSink = (event: AgentEvent) => void | Promise<void>;
