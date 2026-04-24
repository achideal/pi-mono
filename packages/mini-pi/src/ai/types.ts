// OpenAI compatible API types
export interface ChatMessage {
	role: "user" | "assistant" | "tool";
	content: string;
	tool_calls?: ToolCall[];
	tool_call_id?: string;
}

export interface ToolCall {
	id: string;
	type: "function";
	function: {
		name: string;
		arguments: string;
	};
}

export interface FunctionDefinition {
	name: string;
	description?: string;
	parameters?: Record<string, unknown>;
}

export interface ChatCompletionRequest {
	model: string;
	messages: ChatMessage[];
	tools?: { type: "function"; function: FunctionDefinition }[];
	stream?: boolean;
	temperature?: number;
	max_tokens?: number;
}

export interface ChatCompletionResponse {
	id: string;
	choices: CompletionChoice[];
	model: string;
}

export interface CompletionChoice {
	index: number;
	message: {
		role: "assistant";
		content: string | null;
		tool_calls?: ToolCall[];
	};
	finish_reason: string | null;
}

export interface ChatCompletionChunk {
	id: string;
	choices: ChunkChoice[];
	model: string;
}

export interface ChunkChoice {
	index: number;
	delta: {
		role?: "assistant";
		content?: string;
		tool_calls?: DeltaToolCall[];
	};
	finish_reason: string | null;
}

export interface DeltaToolCall {
	index: number;
	id?: string;
	type?: "function";
	function?: {
		name?: string;
		arguments?: string;
	};
}
