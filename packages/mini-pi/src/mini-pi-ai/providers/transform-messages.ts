import type { Api, AssistantMessage, Message, Model, ToolCall, ToolResultMessage } from "../types.js";

export function transformMessages<TApi extends Api>(
	messages: Message[],
	model: Model<TApi>,
	normalizeToolCallId?: (id: string, model: Model<TApi>, source: AssistantMessage) => string,
): Message[] {
	const toolCallIdMap = new Map<string, string>();

	const transformed = messages.map((message) => {
		if (message.role === "user") {
			return message;
		}

		if (message.role === "toolResult") {
			const normalizedId = toolCallIdMap.get(message.toolCallId);
			if (normalizedId && normalizedId !== message.toolCallId) {
				return { ...message, toolCallId: normalizedId };
			}
			return message;
		}

		const assistantMessage = message as AssistantMessage;
		const isSameModel =
			assistantMessage.provider === model.provider &&
			assistantMessage.api === model.api &&
			assistantMessage.model === model.id;

		const transformedContent = assistantMessage.content.flatMap((block) => {
			if (block.type === "thinking") {
				if (block.redacted) {
					return isSameModel ? block : [];
				}
				if (isSameModel && block.thinkingSignature) return block;
				if (!block.thinking.trim()) return [];
				if (isSameModel) return block;
				return {
					type: "text" as const,
					text: `<thinking>\n${block.thinking}\n</thinking>`,
				};
			}

			if (block.type === "toolCall") {
				let transformedToolCall: ToolCall = block;

				if (!isSameModel && normalizeToolCallId) {
					const normalizedId = normalizeToolCallId(block.id, model, assistantMessage);
					if (normalizedId !== block.id) {
						toolCallIdMap.set(block.id, normalizedId);
						transformedToolCall = { ...block, id: normalizedId };
					}
				}

				return transformedToolCall;
			}

			return block;
		});

		return {
			...assistantMessage,
			content: transformedContent,
		};
	});

	const result: Message[] = [];
	let pendingToolCalls: ToolCall[] = [];
	let existingToolResultIds = new Set<string>();

	for (const message of transformed) {
		if (message.role === "assistant") {
			if (pendingToolCalls.length > 0) {
				for (const toolCall of pendingToolCalls) {
					if (!existingToolResultIds.has(toolCall.id)) {
						result.push(createSyntheticToolResult(toolCall));
					}
				}
				pendingToolCalls = [];
				existingToolResultIds = new Set();
			}

			if (message.stopReason === "error" || message.stopReason === "aborted") {
				continue;
			}

			const toolCalls = message.content.filter((block) => block.type === "toolCall") as ToolCall[];
			if (toolCalls.length > 0) {
				pendingToolCalls = toolCalls;
				existingToolResultIds = new Set();
			}

			result.push(message);
			continue;
		}

		if (message.role === "toolResult") {
			existingToolResultIds.add(message.toolCallId);
			result.push(message);
			continue;
		}

		if (pendingToolCalls.length > 0) {
			for (const toolCall of pendingToolCalls) {
				if (!existingToolResultIds.has(toolCall.id)) {
					result.push(createSyntheticToolResult(toolCall));
				}
			}
			pendingToolCalls = [];
			existingToolResultIds = new Set();
		}

		result.push(message);
	}

	return result;
}

function createSyntheticToolResult(toolCall: ToolCall): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		content: [{ type: "text", text: "No result provided" }],
		isError: true,
		timestamp: Date.now(),
	};
}
