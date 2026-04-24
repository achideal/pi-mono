import type { Message, ToolCall } from "../core/types.js";
import type { ChatMessage, ToolCall as OpenAIToolCall } from "./types.js";

export function toOpenAIMessage(message: Message): ChatMessage {
	const msg: ChatMessage = {
		role: message.role,
		content: message.content,
	};

	if (message.toolCalls && message.toolCalls.length > 0) {
		msg.tool_calls = message.toolCalls.map(toOpenAIToolCall);
	}

	if (message.toolResult) {
		msg.tool_call_id = message.toolResult.toolCallId;
	}

	return msg;
}

export function fromOpenAIMessage(msg: ChatMessage): Message {
	const message: Message = {
		role: msg.role,
		content: msg.content || "",
	};

	if (msg.tool_calls && msg.tool_calls.length > 0) {
		message.toolCalls = msg.tool_calls.map(fromOpenAIToolCall);
	}

	return message;
}

export function toOpenAIToolCall(toolCall: ToolCall): OpenAIToolCall {
	return {
		id: toolCall.id,
		type: "function",
		function: {
			name: toolCall.name,
			arguments: toolCall.arguments,
		},
	};
}

export function fromOpenAIToolCall(toolCall: OpenAIToolCall): ToolCall {
	return {
		id: toolCall.id,
		name: toolCall.function.name,
		arguments: toolCall.function.arguments,
	};
}

export function createToolResultMessage(toolCallId: string, result: string, isError = false): Message {
	return {
		role: "tool",
		content: result,
		toolResult: {
			toolCallId,
			content: result,
			isError,
		},
	};
}
