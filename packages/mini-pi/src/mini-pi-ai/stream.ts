import { streamOpenAICompletions } from "./providers/openai-completions.js";
import { streamOpenAIResponses } from "./providers/openai-responses.js";
import type { Api, AssistantMessage, Context, Model, StreamOptions } from "./types.js";

export function stream<TApi extends Api>(model: Model<TApi>, context: Context, options?: StreamOptions) {
	if (model.api === "openai-completions") {
		return streamOpenAICompletions(model as Model<"openai-completions">, context, options);
	}

	if (model.api === "openai-responses") {
		return streamOpenAIResponses(model as Model<"openai-responses">, context, options);
	}

	throw new Error(`Unsupported API: ${model.api}`);
}

export async function complete<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: StreamOptions,
): Promise<AssistantMessage> {
	const responseStream = stream(model, context, options);
	return responseStream.result();
}
