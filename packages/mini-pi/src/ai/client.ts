import type { Message, Tool } from "../core/types.js";
import { toOpenAIMessage } from "./messages.js";
import { parseStreamChunk, SSEParser, type StreamEvent } from "./stream.js";
import { toOpenAITools as toOpenAIToolsUtil } from "./tools.js";
import type { ChatCompletionRequest } from "./types.js";

export interface ClientConfig {
	apiKey: string;
	apiUrl: string;
	model: string;
}

export class AIClient {
	private config: ClientConfig;

	constructor(config: ClientConfig) {
		this.config = config;
	}

	async *stream(messages: Message[], tools: Tool[]): AsyncGenerator<StreamEvent> {
		const openAIMessages = messages.map(toOpenAIMessage);
		const openAITools = toOpenAIToolsUtil(tools);

		const request: ChatCompletionRequest = {
			model: this.config.model,
			messages: openAIMessages,
			tools: openAITools,
			stream: true,
		};

		const response = await fetch(`${this.config.apiUrl}/chat/completions`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${this.config.apiKey}`,
			},
			body: JSON.stringify(request),
		});

		if (!response.ok) {
			const error = await response.text();
			throw new Error(`API request failed: ${response.status} ${error}`);
		}

		const reader = response.body?.getReader();
		if (!reader) {
			throw new Error("No response body");
		}

		const decoder = new TextDecoder();
		const parser = new SSEParser();

		// Track accumulating tool calls
		const toolCallBuffer = new Map<number, { id?: string; name?: string; args: string }>();

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				const chunk = decoder.decode(value, { stream: true });
				const lines = parser.push(chunk);

				for (const line of lines) {
					for (const event of parseStreamChunk(line)) {
						if (event.type === "toolcall_start") {
							const data = event.data as { id: string; name: string; arguments: string };
							toolCallBuffer.set(0, { id: data.id, args: "" });
						} else if (event.type === "toolcall_delta") {
							const data = event.data as { index: number; id?: string; name?: string; args?: string };
							const existing = toolCallBuffer.get(data.index) || { args: "" };

							if (data.id) existing.id = data.id;
							if (data.name) existing.name = data.name;
							if (data.args) existing.args += data.args;

							toolCallBuffer.set(data.index, existing);
						} else if (event.type === "done") {
							// Emit final tool calls
							for (const [_index, tc] of toolCallBuffer) {
								if (tc.id && tc.name) {
									yield {
										type: "toolcall_end",
										data: { id: tc.id, name: tc.name, arguments: tc.args },
									};
								}
							}
							toolCallBuffer.clear();
						}

						yield event;
					}
				}
			}
		} finally {
			reader.releaseLock();
		}
	}

	async complete(
		messages: Message[],
		tools: Tool[],
	): Promise<{ content: string; toolCalls: Array<{ id: string; name: string; arguments: string }> }> {
		let content = "";
		const toolCalls: Array<{ id: string; name: string; arguments: string }> = [];

		for await (const event of this.stream(messages, tools)) {
			if (event.type === "text_delta") {
				const data = event.data as { delta: string };
				content += data.delta;
			} else if (event.type === "toolcall_end") {
				const data = event.data as { id: string; name: string; arguments: string };
				toolCalls.push({ id: data.id, name: data.name, arguments: data.arguments });
			}
		}

		return { content, toolCalls };
	}
}
