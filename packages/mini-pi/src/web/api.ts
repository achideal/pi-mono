/**
 * web/api.ts — 前后端共享的 API 契约。
 *
 * 【教学要点】
 * 让前后端**共享类型**是减少协议不一致 bug 的最廉价手段。
 * 这里定义的接口同时被：
 *   - 服务端（src/web/server.ts）用于校验请求 / 构造响应
 *   - 客户端（src/web/client/api.ts）用于请求体类型
 *   - SSE 事件（event-hub.ts）用于序列化
 */

import type { AgentEvent } from "../agent/index.js";
import type { SessionSummary } from "../session/index.js";

/** 发起新 prompt 的请求体。 */
export interface PromptRequest {
	sessionId: string;
	text: string;
}

/** 列出会话的响应。 */
export interface ListSessionsResponse {
	sessions: SessionSummary[];
}

/** 创建会话的响应。 */
export interface CreateSessionResponse {
	sessionId: string;
}

/** 打开会话并获取初始 transcript 的响应。 */
export interface OpenSessionResponse {
	sessionId: string;
	messages: Array<{
		role: "system" | "user" | "assistant" | "tool";
		content: string;
		toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
		toolCallId?: string;
	}>;
}

/**
 * 服务端通过 SSE 推送给前端的事件。
 * 直接复用 AgentEvent + 几个额外的会话级事件（error/info）。
 */
export type ServerEvent =
	| { kind: "agent"; event: AgentEvent }
	| { kind: "info"; message: string }
	| { kind: "error"; message: string }
	| { kind: "compacted"; messagesAfter: number };
