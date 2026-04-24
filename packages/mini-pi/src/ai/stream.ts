import type { DeltaToolCall } from "./types.js";

export interface StreamEvent {
	type: "text_delta" | "toolcall_start" | "toolcall_delta" | "toolcall_end" | "done";
	data?: unknown;
}

export interface TextDeltaEvent extends StreamEvent {
	type: "text_delta";
	data: { delta: string };
}

export interface ToolCallStartEvent extends StreamEvent {
	type: "toolcall_start";
	data: { id: string; name: string; arguments: string };
}

export interface ToolCallDeltaEvent extends StreamEvent {
	type: "toolcall_delta";
	data: { index: number; id?: string; name?: string; args?: string };
}

export interface ToolCallEndEvent extends StreamEvent {
	type: "toolcall_end";
	data: { id: string; name: string; arguments: string };
}

export class SSEParser {
	private buffer = "";

	push(chunk: string): string[] {
		this.buffer += chunk;
		const lines: string[] = [];

		let newlineIndex = this.buffer.indexOf("\n");
		while (newlineIndex !== -1) {
			const line = this.buffer.slice(0, newlineIndex);
			this.buffer = this.buffer.slice(newlineIndex + 1);
			if (line.trim()) {
				lines.push(line);
			}
			newlineIndex = this.buffer.indexOf("\n");
		}

		return lines;
	}

	reset(): void {
		this.buffer = "";
	}
}

export function parseSSELine(line: string): string | null {
	if (line.startsWith("data: ")) {
		const data = line.slice(6);
		if (data === "[DONE]") {
			return "[DONE]";
		}
		try {
			return JSON.parse(data);
		} catch {
			return null;
		}
	}
	return null;
}

export function* parseStreamChunk(chunk: string): Generator<StreamEvent> {
	const data = parseSSELine(chunk);
	if (!data || data === "[DONE]") {
		if (data === "[DONE]") {
			yield { type: "done" };
		}
		return;
	}

	const parsed = JSON.parse(data) as {
		choices: Array<{ delta: { content?: string; tool_calls?: DeltaToolCall[] }; finish_reason: string | null }>;
	};

	const choice = parsed.choices[0];
	if (!choice) return;

	if (choice.delta.content) {
		yield { type: "text_delta", data: { delta: choice.delta.content } };
	}

	if (choice.delta.tool_calls) {
		for (const tc of choice.delta.tool_calls) {
			if (tc.id) {
				yield {
					type: "toolcall_start",
					data: { id: tc.id, name: "", arguments: "" },
				};
			}

			if (tc.function?.name) {
				yield {
					type: "toolcall_delta",
					data: { index: tc.index, name: tc.function.name },
				};
			}

			if (tc.function?.arguments) {
				yield {
					type: "toolcall_delta",
					data: { index: tc.index, args: tc.function.arguments },
				};
			}
		}
	}

	if (choice.finish_reason === "stop" || choice.finish_reason === "tool_calls" || choice.finish_reason === "length") {
		yield { type: "done" };
	}
}
