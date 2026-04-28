/**
 * ai 层公共导出。
 *
 * 只导出"外部会用到"的东西：类型 + 两个 provider + 工厂。
 * SSE 解析是内部实现细节，不在公共 API 里。
 */

export { streamChatCompletions } from "./chat-completions.js";
export { type ProviderKind, pickProvider } from "./provider-factory.js";
export { streamResponses } from "./responses.js";
export type {
	AssistantMessage,
	Message,
	StopReason,
	StreamEvent,
	StreamFn,
	StreamOptions,
	SystemMessage,
	TextContent,
	ToolCall,
	ToolParameter,
	ToolResultMessage,
	ToolSchema,
	UserMessage,
} from "./types.js";
