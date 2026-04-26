import type OpenAI from "openai";
import type {
	Tool as OpenAITool,
	ResponseFunctionToolCall,
	ResponseInput,
	ResponseInputContent,
	ResponseInputText,
	ResponseOutputMessage,
	ResponseReasoningItem,
	ResponseStreamEvent,
} from "openai/resources/responses/responses.js";
import type {
	Api,
	AssistantMessage,
	Context,
	Model,
	StopReason,
	TextContent,
	ThinkingContent,
	Tool,
	ToolCall,
} from "../types.js";
import { createEmptyUsage } from "../types.js";
import type { AssistantMessageEventStream } from "../utils/event-stream.js";
import { parseStreamingJson } from "../utils/json-parse.js";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.js";
import { transformMessages } from "./transform-messages.js";

interface TextSignatureV1 {
	v: 1;
	id: string;
}

function encodeTextSignature(id: string): string {
	const payload: TextSignatureV1 = { v: 1, id };
	return JSON.stringify(payload);
}

function parseTextSignature(signature: string | undefined): { id: string } | undefined {
	if (!signature) return undefined;
	if (!signature.startsWith("{")) {
		return { id: signature };
	}

	try {
		const parsed = JSON.parse(signature) as Partial<TextSignatureV1>;
		if (parsed.v === 1 && typeof parsed.id === "string") {
			return { id: parsed.id };
		}
	} catch {
		return undefined;
	}

	return undefined;
}

export function convertResponsesMessages<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	allowedToolCallProviders: ReadonlySet<string>,
): ResponseInput {
	const messages: ResponseInput = [];

	const normalizeToolCallId = (id: string, targetModel: Model<TApi>, source: AssistantMessage): string => {
		if (!allowedToolCallProviders.has(targetModel.provider)) {
			return sanitizeId(id);
		}

		if (!id.includes("|")) {
			return sanitizeId(id);
		}

		const [callId, itemId] = id.split("|");
		const normalizedCallId = sanitizeId(callId);
		const normalizedItemId =
			source.provider === targetModel.provider && source.api === targetModel.api
				? ensureResponsesItemId(sanitizeId(itemId))
				: ensureResponsesItemId(`fc_${sanitizeId(itemId)}`);

		return `${normalizedCallId}|${normalizedItemId}`;
	};

	const transformedMessages = transformMessages(context.messages, model, normalizeToolCallId);

	if (context.systemPrompt) {
		messages.push({
			role: model.reasoning ? "developer" : "system",
			content: sanitizeSurrogates(context.systemPrompt),
		});
	}

	let messageIndex = 0;
	for (const message of transformedMessages) {
		if (message.role === "user") {
			if (typeof message.content === "string") {
				messages.push({
					role: "user",
					content: [{ type: "input_text", text: sanitizeSurrogates(message.content) }],
				});
			} else {
				const content = message.content.map((block): ResponseInputContent => {
					return {
						type: "input_text",
						text: sanitizeSurrogates(block.text),
					} satisfies ResponseInputText;
				});
				messages.push({ role: "user", content });
			}
			messageIndex++;
			continue;
		}

		if (message.role === "assistant") {
			const output: ResponseInput = [];

			for (const block of message.content) {
				if (block.type === "thinking") {
					if (block.thinkingSignature) {
						output.push(JSON.parse(block.thinkingSignature) as ResponseReasoningItem);
					}
					continue;
				}

				if (block.type === "text") {
					const parsedSignature = parseTextSignature(block.textSignature);
					output.push({
						type: "message",
						role: "assistant",
						content: [{ type: "output_text", text: sanitizeSurrogates(block.text), annotations: [] }],
						status: "completed",
						id: parsedSignature?.id || `msg_${messageIndex}`,
					} satisfies ResponseOutputMessage);
					continue;
				}

				const [callId, itemId] = block.id.split("|");
				output.push({
					type: "function_call",
					id: itemId,
					call_id: callId,
					name: block.name,
					arguments: JSON.stringify(block.arguments),
				} satisfies ResponseFunctionToolCall);
			}

			if (output.length > 0) {
				messages.push(...output);
			}

			messageIndex++;
			continue;
		}

		const [callId] = message.toolCallId.split("|");
		messages.push({
			type: "function_call_output",
			call_id: callId,
			output: sanitizeSurrogates(message.content.map((block) => block.text).join("\n")),
		});
		messageIndex++;
	}

	return messages;
}

export function convertResponsesTools(tools: Tool[]): OpenAITool[] {
	return tools.map((tool) => ({
		type: "function",
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters as Record<string, unknown>,
		strict: false,
	}));
}

export async function processResponsesStream<TApi extends Api>(
	openaiStream: AsyncIterable<ResponseStreamEvent>,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	_model: Model<TApi>,
): Promise<void> {
	let currentItem: ResponseReasoningItem | ResponseOutputMessage | ResponseFunctionToolCall | null = null;
	let currentBlock: ThinkingContent | TextContent | (ToolCall & { partialJson: string }) | null = null;
	const blocks = output.content;
	const blockIndex = () => blocks.length - 1;

	for await (const event of openaiStream) {
		if (event.type === "response.created") {
			output.responseId = event.response.id;
			continue;
		}

		if (event.type === "response.output_item.added") {
			if (event.item.type === "reasoning") {
				currentItem = event.item;
				currentBlock = { type: "thinking", thinking: "" };
				output.content.push(currentBlock);
				stream.push({ type: "thinking_start", contentIndex: blockIndex(), partial: output });
				continue;
			}

			if (event.item.type === "message") {
				currentItem = event.item;
				currentBlock = { type: "text", text: "" };
				output.content.push(currentBlock);
				stream.push({ type: "text_start", contentIndex: blockIndex(), partial: output });
				continue;
			}

			if (event.item.type === "function_call") {
				currentItem = event.item;
				currentBlock = {
					type: "toolCall",
					id: `${event.item.call_id}|${event.item.id}`,
					name: event.item.name,
					arguments: {},
					partialJson: event.item.arguments || "",
				};
				output.content.push(currentBlock);
				stream.push({ type: "toolcall_start", contentIndex: blockIndex(), partial: output });
			}

			continue;
		}

		if (event.type === "response.reasoning_summary_part.added") {
			if (currentItem?.type === "reasoning") {
				currentItem.summary = currentItem.summary || [];
				currentItem.summary.push(event.part);
			}
			continue;
		}

		if (event.type === "response.reasoning_summary_text.delta") {
			if (currentItem?.type === "reasoning" && currentBlock?.type === "thinking") {
				currentBlock.thinking += event.delta;
				stream.push({
					type: "thinking_delta",
					contentIndex: blockIndex(),
					delta: event.delta,
					partial: output,
				});
			}
			continue;
		}

		if (event.type === "response.reasoning_summary_part.done") {
			if (currentItem?.type === "reasoning" && currentBlock?.type === "thinking") {
				currentBlock.thinking += "\n\n";
				stream.push({
					type: "thinking_delta",
					contentIndex: blockIndex(),
					delta: "\n\n",
					partial: output,
				});
			}
			continue;
		}

		if (event.type === "response.content_part.added") {
			if (currentItem?.type === "message") {
				currentItem.content = currentItem.content || [];
				if (event.part.type === "output_text" || event.part.type === "refusal") {
					currentItem.content.push(event.part);
				}
			}
			continue;
		}

		if (event.type === "response.output_text.delta") {
			if (currentItem?.type === "message" && currentBlock?.type === "text") {
				currentBlock.text += event.delta;
				stream.push({
					type: "text_delta",
					contentIndex: blockIndex(),
					delta: event.delta,
					partial: output,
				});
			}
			continue;
		}

		if (event.type === "response.refusal.delta") {
			if (currentItem?.type === "message" && currentBlock?.type === "text") {
				currentBlock.text += event.delta;
				stream.push({
					type: "text_delta",
					contentIndex: blockIndex(),
					delta: event.delta,
					partial: output,
				});
			}
			continue;
		}

		if (event.type === "response.function_call_arguments.delta") {
			if (currentItem?.type === "function_call" && currentBlock?.type === "toolCall") {
				currentBlock.partialJson += event.delta;
				currentBlock.arguments = parseStreamingJson(currentBlock.partialJson);
				stream.push({
					type: "toolcall_delta",
					contentIndex: blockIndex(),
					delta: event.delta,
					partial: output,
				});
			}
			continue;
		}

		if (event.type === "response.function_call_arguments.done") {
			if (currentItem?.type === "function_call" && currentBlock?.type === "toolCall") {
				const previous = currentBlock.partialJson;
				currentBlock.partialJson = event.arguments;
				currentBlock.arguments = parseStreamingJson(currentBlock.partialJson);
				const delta = event.arguments.startsWith(previous) ? event.arguments.slice(previous.length) : "";
				if (delta) {
					stream.push({
						type: "toolcall_delta",
						contentIndex: blockIndex(),
						delta,
						partial: output,
					});
				}
			}
			continue;
		}

		if (event.type === "response.output_item.done") {
			if (event.item.type === "reasoning" && currentBlock?.type === "thinking") {
				currentBlock.thinking = event.item.summary?.map((item) => item.text).join("\n\n") || "";
				currentBlock.thinkingSignature = JSON.stringify(event.item);
				stream.push({
					type: "thinking_end",
					contentIndex: blockIndex(),
					content: currentBlock.thinking,
					partial: output,
				});
				currentBlock = null;
				continue;
			}

			if (event.item.type === "message" && currentBlock?.type === "text") {
				currentBlock.text = event.item.content
					.map((item) => (item.type === "output_text" ? item.text : item.refusal))
					.join("");
				currentBlock.textSignature = encodeTextSignature(event.item.id);
				stream.push({
					type: "text_end",
					contentIndex: blockIndex(),
					content: currentBlock.text,
					partial: output,
				});
				currentBlock = null;
				continue;
			}

			if (event.item.type === "function_call") {
				const toolCall: ToolCall = {
					type: "toolCall",
					id: `${event.item.call_id}|${event.item.id}`,
					name: event.item.name,
					arguments:
						currentBlock?.type === "toolCall"
							? parseStreamingJson(currentBlock.partialJson)
							: parseStreamingJson(event.item.arguments || "{}"),
				};
				currentBlock = null;
				stream.push({ type: "toolcall_end", contentIndex: blockIndex(), toolCall, partial: output });
			}
			continue;
		}

		if (event.type === "response.completed") {
			if (event.response.id) {
				output.responseId = event.response.id;
			}

			if (event.response.usage) {
				const cachedTokens = event.response.usage.input_tokens_details?.cached_tokens || 0;
				output.usage = {
					...createEmptyUsage(),
					input: (event.response.usage.input_tokens || 0) - cachedTokens,
					output: event.response.usage.output_tokens || 0,
					cacheRead: cachedTokens,
					cacheWrite: 0,
					totalTokens: event.response.usage.total_tokens || 0,
				};
			}

			output.stopReason = mapStopReason(event.response.status);
			if (output.content.some((block) => block.type === "toolCall") && output.stopReason === "stop") {
				output.stopReason = "toolUse";
			}
			continue;
		}

		if (event.type === "error") {
			throw new Error(`Error Code ${event.code}: ${event.message}`);
		}

		if (event.type === "response.failed") {
			const message = event.response.error?.message || event.response.incomplete_details?.reason || "Unknown error";
			throw new Error(message);
		}
	}
}

function sanitizeId(value: string): string {
	return value
		.replace(/[^a-zA-Z0-9_-]/g, "_")
		.slice(0, 64)
		.replace(/_+$/g, "");
}

function ensureResponsesItemId(value: string): string {
	return value.startsWith("fc_") ? value : `fc_${value}`.slice(0, 64);
}

function mapStopReason(status: OpenAI.Responses.ResponseStatus | undefined): StopReason {
	if (!status) return "stop";

	switch (status) {
		case "completed":
			return "stop";
		case "incomplete":
			return "length";
		case "failed":
		case "cancelled":
			return "error";
		case "in_progress":
		case "queued":
			return "stop";
	}
}
