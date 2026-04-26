import OpenAI from "openai";
import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses.js";
import type { AssistantMessage, Context, Model, ReasoningEffort, StreamFunction, StreamOptions } from "../types.js";
import { createEmptyUsage } from "../types.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import { convertResponsesMessages, convertResponsesTools, processResponsesStream } from "./openai-responses-shared.js";

const OPENAI_TOOL_CALL_PROVIDERS = new Set(["openai-compatible"]);

export interface OpenAIResponsesOptions extends StreamOptions {
	reasoningEffort?: ReasoningEffort;
	reasoningSummary?: "auto" | "detailed" | "concise" | null;
}

export const streamOpenAIResponses: StreamFunction<"openai-responses", OpenAIResponsesOptions> = (
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
				params = nextParams as ResponseCreateParamsStreaming;
			}

			const openaiStream = await client.responses.create(
				params,
				options?.signal ? { signal: options.signal } : undefined,
			);

			stream.push({ type: "start", partial: output });
			await processResponsesStream(openaiStream, output, stream, model);

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

function resolveApiKey(model: Model<"openai-responses">, options?: StreamOptions): string {
	const modelApiKey = "apiKey" in model && typeof model.apiKey === "string" ? model.apiKey : undefined;
	const apiKey = options?.apiKey?.trim() || modelApiKey?.trim();
	if (!apiKey) {
		throw new Error(`No API key configured for model "${model.id}".`);
	}
	return apiKey;
}

function buildParams(
	model: Model<"openai-responses">,
	context: Context,
	options?: OpenAIResponsesOptions,
): ResponseCreateParamsStreaming {
	const params: ResponseCreateParamsStreaming = {
		model: model.id,
		input: convertResponsesMessages(model, context, OPENAI_TOOL_CALL_PROVIDERS),
		stream: true,
	};

	if (options?.maxTokens !== undefined) {
		params.max_output_tokens = options.maxTokens;
	}

	if (options?.temperature !== undefined) {
		params.temperature = options.temperature;
	}

	if (context.tools?.length) {
		params.tools = convertResponsesTools(context.tools);
	}

	if (options?.reasoningEffort || options?.reasoningSummary) {
		params.reasoning = {
			effort: options?.reasoningEffort || "medium",
			summary: options?.reasoningSummary || "auto",
		};
		params.include = ["reasoning.encrypted_content"];
	}

	return params;
}
