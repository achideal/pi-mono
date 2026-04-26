import OpenAI from "openai";
import type {
	ChatCompletionAssistantMessageParam,
	ChatCompletionChunk,
	ChatCompletionMessageParam,
	ChatCompletionToolMessageParam,
} from "openai/resources/chat/completions.js";
import type {
	AssistantMessage,
	Context,
	Model,
	ReasoningEffort,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingContent,
	Tool,
	ToolCall,
	ToolResultMessage,
	Usage,
} from "../types.js";
import { createEmptyUsage } from "../types.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import { parseStreamingJson } from "../utils/json-parse.js";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.js";
import { transformMessages } from "./transform-messages.js";

export interface OpenAICompletionsOptions extends StreamOptions {
	toolChoice?: "auto" | "none" | "required" | { type: "function"; function: { name: string } };
	reasoningEffort?: ReasoningEffort;
}

export const streamOpenAICompletions: StreamFunction<"openai-completions", OpenAICompletionsOptions> = (
	model,
	context,
	options,
) => {
	const stream = new AssistantMessageEventStream();

	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: createEmptyUsage(),
			stopReason: "stop",
			timestamp: Date.now(),
		};

		try {
			const apiKey = resolveApiKey(model, options);
			const client = new OpenAI({
				apiKey,
				baseURL: model.baseUrl,
				dangerouslyAllowBrowser: true,
				defaultHeaders: { ...options?.headers },
			});

			let params = buildParams(model, context, options);
			const nextParams = await options?.onPayload?.(params, model);
			if (nextParams !== undefined) {
				params = nextParams as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming;
			}

			const openaiStream = await client.chat.completions.create(params, { signal: options?.signal });
			stream.push({ type: "start", partial: output });

			let currentBlock: TextContent | ThinkingContent | (ToolCall & { partialArgs?: string }) | null = null;
			const blocks = output.content;
			const blockIndex = () => blocks.length - 1;

			const finishCurrentBlock = (block?: typeof currentBlock) => {
				if (!block) return;

				if (block.type === "text") {
					stream.push({
						type: "text_end",
						contentIndex: blockIndex(),
						content: block.text,
						partial: output,
					});
					return;
				}

				if (block.type === "thinking") {
					stream.push({
						type: "thinking_end",
						contentIndex: blockIndex(),
						content: block.thinking,
						partial: output,
					});
					return;
				}

				block.arguments = parseStreamingJson(block.partialArgs);
				delete block.partialArgs;
				stream.push({
					type: "toolcall_end",
					contentIndex: blockIndex(),
					toolCall: block,
					partial: output,
				});
			};

			for await (const chunk of openaiStream) {
				output.responseId ||= chunk.id;
				if (chunk.usage) {
					output.usage = parseChunkUsage(chunk.usage);
				}

				const choice = chunk.choices[0];
				if (!choice) continue;

				if (choice.finish_reason) {
					const mapped = mapStopReason(choice.finish_reason);
					output.stopReason = mapped.stopReason;
					output.errorMessage = mapped.errorMessage;
				}

				if (!choice.delta) continue;

				if (choice.delta.content) {
					if (!currentBlock || currentBlock.type !== "text") {
						finishCurrentBlock(currentBlock);
						currentBlock = { type: "text", text: "" };
						output.content.push(currentBlock);
						stream.push({ type: "text_start", contentIndex: blockIndex(), partial: output });
					}

					currentBlock.text += choice.delta.content;
					stream.push({
						type: "text_delta",
						contentIndex: blockIndex(),
						delta: choice.delta.content,
						partial: output,
					});
				}

				const reasoningDelta = extractReasoningDelta(choice.delta);
				if (reasoningDelta) {
					if (!currentBlock || currentBlock.type !== "thinking") {
						finishCurrentBlock(currentBlock);
						currentBlock = { type: "thinking", thinking: "" };
						output.content.push(currentBlock);
						stream.push({ type: "thinking_start", contentIndex: blockIndex(), partial: output });
					}

					currentBlock.thinking += reasoningDelta;
					stream.push({
						type: "thinking_delta",
						contentIndex: blockIndex(),
						delta: reasoningDelta,
						partial: output,
					});
				}

				if (choice.delta.tool_calls) {
					for (const toolCall of choice.delta.tool_calls) {
						if (
							!currentBlock ||
							currentBlock.type !== "toolCall" ||
							(toolCall.id && currentBlock.id !== toolCall.id)
						) {
							finishCurrentBlock(currentBlock);
							currentBlock = {
								type: "toolCall",
								id: toolCall.id || "",
								name: toolCall.function?.name || "",
								arguments: {},
								partialArgs: "",
							};
							output.content.push(currentBlock);
							stream.push({ type: "toolcall_start", contentIndex: blockIndex(), partial: output });
						}

						if (toolCall.id) currentBlock.id = toolCall.id;
						if (toolCall.function?.name) currentBlock.name = toolCall.function.name;

						const delta = toolCall.function?.arguments || "";
						if (delta) {
							currentBlock.partialArgs = `${currentBlock.partialArgs || ""}${delta}`;
							currentBlock.arguments = parseStreamingJson(currentBlock.partialArgs);
						}

						stream.push({
							type: "toolcall_delta",
							contentIndex: blockIndex(),
							delta,
							partial: output,
						});
					}
				}
			}

			finishCurrentBlock(currentBlock);

			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			if (output.stopReason === "aborted") {
				throw new Error("Request was aborted");
			}

			if (output.stopReason === "error") {
				throw new Error(output.errorMessage || "Provider returned an error stop reason");
			}

			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

function resolveApiKey(model: Model<"openai-completions">, options?: StreamOptions): string {
	const modelApiKey = "apiKey" in model && typeof model.apiKey === "string" ? model.apiKey : undefined;
	const apiKey = options?.apiKey?.trim() || modelApiKey?.trim();
	if (!apiKey) {
		throw new Error(`No API key configured for model "${model.id}".`);
	}
	return apiKey;
}

function buildParams(
	model: Model<"openai-completions">,
	context: Context,
	options?: OpenAICompletionsOptions,
): OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming {
	const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
		model: model.id,
		messages: convertMessages(model, context),
		stream: true,
	};

	if (options?.maxTokens !== undefined) {
		(params as { max_tokens?: number }).max_tokens = options.maxTokens;
	}

	if (options?.temperature !== undefined) {
		params.temperature = options.temperature;
	}

	if (context.tools?.length) {
		params.tools = convertTools(context.tools);
	}

	if (options?.toolChoice) {
		params.tool_choice = options.toolChoice;
	}

	if (options?.reasoningEffort) {
		(params as { reasoning_effort?: ReasoningEffort }).reasoning_effort = options.reasoningEffort;
	}

	return params;
}

function convertMessages(model: Model<"openai-completions">, context: Context): ChatCompletionMessageParam[] {
	const params: ChatCompletionMessageParam[] = [];
	const transformedMessages = transformMessages(context.messages, model);

	if (context.systemPrompt) {
		params.push({
			role: "system",
			content: sanitizeSurrogates(context.systemPrompt),
		});
	}

	for (const message of transformedMessages) {
		if (message.role === "user") {
			params.push({
				role: "user",
				content: sanitizeSurrogates(flattenTextContent(message.content)),
			});
			continue;
		}

		if (message.role === "assistant") {
			const assistantMessage: ChatCompletionAssistantMessageParam = {
				role: "assistant",
				content: null,
			};

			const content = [
				...message.content
					.filter((block): block is ThinkingContent => block.type === "thinking")
					.map((block) => {
						return `<thinking>\n${block.thinking}\n</thinking>`;
					}),
				...message.content
					.filter((block): block is TextContent => block.type === "text")
					.map((block) => block.text),
			]
				.filter((block) => block.trim().length > 0)
				.join("\n\n");

			if (content.length > 0) {
				assistantMessage.content = sanitizeSurrogates(content);
			}

			const toolCalls = message.content.filter((block): block is ToolCall => block.type === "toolCall");
			if (toolCalls.length > 0) {
				assistantMessage.tool_calls = toolCalls.map((toolCall) => ({
					id: toolCall.id,
					type: "function",
					function: {
						name: toolCall.name,
						arguments: JSON.stringify(toolCall.arguments),
					},
				}));
			}

			if (!assistantMessage.content && !assistantMessage.tool_calls) {
				continue;
			}

			params.push(assistantMessage);
			continue;
		}

		const toolResultMessage = message as ToolResultMessage;
		const toolResult: ChatCompletionToolMessageParam = {
			role: "tool",
			tool_call_id: toolResultMessage.toolCallId,
			content: sanitizeSurrogates(flattenTextContent(toolResultMessage.content)),
		};
		params.push(toolResult);
	}

	return params;
}

function convertTools(tools: Tool[]): OpenAI.Chat.Completions.ChatCompletionTool[] {
	return tools.map((tool) => ({
		type: "function",
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters as Record<string, unknown>,
		},
	}));
}

function flattenTextContent(content: string | TextContent[]): string {
	if (typeof content === "string") {
		return content;
	}
	return content.map((block) => block.text).join("\n");
}

function parseChunkUsage(rawUsage: {
	prompt_tokens?: number;
	completion_tokens?: number;
	prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
	completion_tokens_details?: { reasoning_tokens?: number };
}): Usage {
	const cacheRead = rawUsage.prompt_tokens_details?.cached_tokens || 0;
	const cacheWrite = rawUsage.prompt_tokens_details?.cache_write_tokens || 0;
	const reasoningTokens = rawUsage.completion_tokens_details?.reasoning_tokens || 0;
	const input = Math.max(0, (rawUsage.prompt_tokens || 0) - cacheRead - cacheWrite);
	const output = (rawUsage.completion_tokens || 0) + reasoningTokens;

	return {
		...createEmptyUsage(),
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
	};
}

function mapStopReason(reason: ChatCompletionChunk.Choice["finish_reason"] | string): {
	stopReason: AssistantMessage["stopReason"];
	errorMessage?: string;
} {
	if (reason === null) {
		return { stopReason: "stop" };
	}

	switch (reason) {
		case "stop":
		case "end":
			return { stopReason: "stop" };
		case "length":
			return { stopReason: "length" };
		case "tool_calls":
		case "function_call":
			return { stopReason: "toolUse" };
		case "content_filter":
			return { stopReason: "error", errorMessage: "Provider finish_reason: content_filter" };
		default:
			return { stopReason: "error", errorMessage: `Provider finish_reason: ${reason}` };
	}
}

function extractReasoningDelta(delta: ChatCompletionChunk.Choice.Delta): string | undefined {
	const candidates = [
		(delta as Record<string, unknown>).reasoning_content,
		(delta as Record<string, unknown>).reasoning,
		(delta as Record<string, unknown>).reasoning_text,
	];

	for (const candidate of candidates) {
		if (typeof candidate === "string" && candidate.length > 0) {
			return candidate;
		}
	}

	return undefined;
}
