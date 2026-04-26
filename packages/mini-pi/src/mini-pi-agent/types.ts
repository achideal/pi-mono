import type { Static, TSchema } from "@sinclair/typebox";
import type { stream } from "../mini-pi-ai/stream.js";
import type {
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	Message,
	Model,
	StreamOptions,
	TextContent,
	Tool,
	ToolCall,
	ToolResultMessage,
	UserMessage,
} from "../mini-pi-ai/types.js";
import type { AssistantMessageEventStream } from "../mini-pi-ai/utils/event-stream.js";

export type StreamFn = (
	...args: Parameters<typeof stream>
) => ReturnType<typeof stream> | Promise<ReturnType<typeof stream>>;

export interface AgentToolResult<TDetails = unknown> {
	content: TextContent[];
	details: TDetails;
}

export type AgentToolUpdateCallback<TDetails = unknown> = (partialResult: AgentToolResult<TDetails>) => void;

export interface AgentTool<TParameters extends TSchema = TSchema, TDetails = unknown> extends Tool<TParameters> {
	execute(
		toolCallId: string,
		params: Static<TParameters>,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TDetails>,
	): Promise<AgentToolResult<TDetails>>;
}

export interface AgentContext {
	systemPrompt?: string;
	messages: Message[];
	tools?: AgentTool[];
}

export interface AgentLoopConfig extends Omit<StreamOptions, "signal"> {
	model: Model;
}

export interface AgentState {
	systemPrompt: string;
	model: Model;
	set tools(tools: AgentTool[]);
	get tools(): AgentTool[];
	set messages(messages: Message[]);
	get messages(): Message[];
	readonly isStreaming: boolean;
	readonly streamingMessage?: AssistantMessage;
	readonly pendingToolCalls: ReadonlySet<string>;
	readonly errorMessage?: string;
}

export type AgentEvent =
	| { type: "agent_start" }
	| { type: "agent_end"; messages: Message[] }
	| { type: "turn_start" }
	| { type: "turn_end"; message: AssistantMessage; toolResults: ToolResultMessage[] }
	| { type: "message_start"; message: Message }
	| {
			type: "message_update";
			message: AssistantMessage;
			assistantMessageEvent: Extract<
				AssistantMessageEvent,
				| { type: "text_start" | "text_delta" | "text_end" }
				| { type: "thinking_start" | "thinking_delta" | "thinking_end" }
				| { type: "toolcall_start" | "toolcall_delta" | "toolcall_end" }
			>;
	  }
	| { type: "message_end"; message: Message }
	| {
			type: "tool_execution_start";
			toolCallId: string;
			toolName: string;
			args: unknown;
	  }
	| {
			type: "tool_execution_update";
			toolCallId: string;
			toolName: string;
			args: unknown;
			partialResult: AgentToolResult;
	  }
	| {
			type: "tool_execution_end";
			toolCallId: string;
			toolName: string;
			args: unknown;
			result: AgentToolResult;
			isError: boolean;
	  };

export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;

export type AgentListener = (event: AgentEvent, signal: AbortSignal) => Promise<void> | void;

export interface AgentOptions {
	initialState?: Partial<Omit<AgentState, "isStreaming" | "streamingMessage" | "pendingToolCalls" | "errorMessage">>;
	streamFn?: StreamFn;
	apiKey?: string;
	headers?: Record<string, string>;
	temperature?: number;
	maxTokens?: number;
	onPayload?: StreamOptions["onPayload"];
}

export type AgentPromptInput = string | UserMessage | UserMessage[];

export type AgentToolCall = ToolCall;
export type { AssistantMessageEventStream, Context, Message, UserMessage };
