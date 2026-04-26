import { stream as streamAssistantMessage } from "../mini-pi-ai/stream.js";
import type { AssistantMessage, Message, ToolResultMessage } from "../mini-pi-ai/types.js";
import { EventStream } from "../mini-pi-ai/utils/event-stream.js";
import type {
	AgentContext,
	AgentEvent,
	AgentEventSink,
	AgentLoopConfig,
	AgentTool,
	AgentToolCall,
	AgentToolResult,
	StreamFn,
} from "./types.js";
import { validateToolArguments } from "./validation.js";

export function agentLoop(
	prompts: Message[],
	context: AgentContext,
	config: AgentLoopConfig,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): EventStream<AgentEvent, Message[]> {
	const stream = createAgentStream();

	void runAgentLoop(
		prompts,
		context,
		config,
		(event) => {
			stream.push(event);
		},
		signal,
		streamFn,
	).then((messages) => {
		stream.end(messages);
	});

	return stream;
}

export function agentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): EventStream<AgentEvent, Message[]> {
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}

	if (context.messages[context.messages.length - 1]?.role === "assistant") {
		throw new Error("Cannot continue from message role: assistant");
	}

	const stream = createAgentStream();

	void runAgentLoopContinue(
		context,
		config,
		(event) => {
			stream.push(event);
		},
		signal,
		streamFn,
	).then((messages) => {
		stream.end(messages);
	});

	return stream;
}

export async function runAgentLoop(
	prompts: Message[],
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): Promise<Message[]> {
	const newMessages = prompts.slice();
	const currentContext: AgentContext = {
		systemPrompt: context.systemPrompt,
		messages: [...context.messages, ...prompts],
		tools: context.tools?.slice(),
	};

	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });
	for (const prompt of prompts) {
		await emit({ type: "message_start", message: prompt });
		await emit({ type: "message_end", message: prompt });
	}

	await runTurns(currentContext, newMessages, config, emit, signal, streamFn);
	return newMessages;
}

export async function runAgentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): Promise<Message[]> {
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}

	if (context.messages[context.messages.length - 1]?.role === "assistant") {
		throw new Error("Cannot continue from message role: assistant");
	}

	const newMessages: Message[] = [];
	const currentContext: AgentContext = {
		systemPrompt: context.systemPrompt,
		messages: context.messages.slice(),
		tools: context.tools?.slice(),
	};

	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });

	await runTurns(currentContext, newMessages, config, emit, signal, streamFn);
	return newMessages;
}

function createAgentStream(): EventStream<AgentEvent, Message[]> {
	return new EventStream<AgentEvent, Message[]>(
		(event) => event.type === "agent_end",
		(event) => {
			if (event.type !== "agent_end") {
				throw new Error("Unexpected agent event");
			}
			return event.messages;
		},
	);
}

async function runTurns(
	currentContext: AgentContext,
	newMessages: Message[],
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): Promise<void> {
	let firstTurn = true;

	while (true) {
		if (!firstTurn) {
			await emit({ type: "turn_start" });
		}
		firstTurn = false;

		const assistantMessage = await streamAssistantResponse(currentContext, config, emit, signal, streamFn);
		newMessages.push(assistantMessage);

		if (assistantMessage.stopReason === "error" || assistantMessage.stopReason === "aborted") {
			await emit({ type: "turn_end", message: assistantMessage, toolResults: [] });
			await emit({ type: "agent_end", messages: newMessages });
			return;
		}

		const toolCalls = assistantMessage.content.filter(
			(content): content is AgentToolCall => content.type === "toolCall",
		);
		const toolResults = toolCalls.length > 0 ? await executeToolCalls(currentContext, toolCalls, emit, signal) : [];

		for (const toolResult of toolResults) {
			currentContext.messages.push(toolResult);
			newMessages.push(toolResult);
		}

		await emit({ type: "turn_end", message: assistantMessage, toolResults });

		if (toolCalls.length === 0) {
			break;
		}
	}

	await emit({ type: "agent_end", messages: newMessages });
}

async function streamAssistantResponse(
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): Promise<AssistantMessage> {
	const { model, ...options } = config;
	const response = await (streamFn || streamAssistantMessage)(
		model,
		{
			systemPrompt: context.systemPrompt,
			messages: context.messages,
			tools: context.tools,
		},
		{
			...options,
			signal,
		},
	);

	let partialMessage: AssistantMessage | undefined;
	let addedPartial = false;

	for await (const event of response) {
		switch (event.type) {
			case "start":
				partialMessage = event.partial;
				context.messages.push(partialMessage);
				addedPartial = true;
				await emit({ type: "message_start", message: { ...partialMessage } });
				break;

			case "text_start":
			case "text_delta":
			case "text_end":
			case "thinking_start":
			case "thinking_delta":
			case "thinking_end":
			case "toolcall_start":
			case "toolcall_delta":
			case "toolcall_end":
				partialMessage = event.partial;
				if (addedPartial) {
					context.messages[context.messages.length - 1] = partialMessage;
				}
				await emit({
					type: "message_update",
					message: { ...partialMessage },
					assistantMessageEvent: event,
				});
				break;

			case "done":
			case "error": {
				const finalMessage = await response.result();
				if (addedPartial) {
					context.messages[context.messages.length - 1] = finalMessage;
				} else {
					context.messages.push(finalMessage);
					await emit({ type: "message_start", message: { ...finalMessage } });
				}
				await emit({ type: "message_end", message: finalMessage });
				return finalMessage;
			}
		}
	}

	const finalMessage = await response.result();
	if (addedPartial) {
		context.messages[context.messages.length - 1] = finalMessage;
	} else {
		context.messages.push(finalMessage);
		await emit({ type: "message_start", message: { ...finalMessage } });
	}
	await emit({ type: "message_end", message: finalMessage });
	return finalMessage;
}

async function executeToolCalls(
	context: AgentContext,
	toolCalls: AgentToolCall[],
	emit: AgentEventSink,
	signal?: AbortSignal,
): Promise<ToolResultMessage[]> {
	const results: ToolResultMessage[] = [];

	for (const toolCall of toolCalls) {
		const tool = context.tools?.find((item) => item.name === toolCall.name);
		if (!tool) {
			await emit({
				type: "tool_execution_start",
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				args: toolCall.arguments,
			});
			results.push(
				await emitToolCallOutcome(
					toolCall,
					toolCall.arguments,
					createErrorToolResult(`Tool "${toolCall.name}" not found.`),
					true,
					emit,
				),
			);
			continue;
		}

		let args: unknown;
		try {
			args = validateToolArguments(tool, toolCall);
		} catch (error) {
			await emit({
				type: "tool_execution_start",
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				args: toolCall.arguments,
			});
			results.push(
				await emitToolCallOutcome(
					toolCall,
					toolCall.arguments,
					createErrorToolResult(error instanceof Error ? error.message : String(error)),
					true,
					emit,
				),
			);
			continue;
		}

		await emit({ type: "tool_execution_start", toolCallId: toolCall.id, toolName: toolCall.name, args });
		results.push(await executeToolCall(tool, toolCall, args, emit, signal));
	}

	return results;
}

async function executeToolCall<TTool extends AgentTool>(
	tool: TTool,
	toolCall: AgentToolCall,
	args: unknown,
	emit: AgentEventSink,
	signal?: AbortSignal,
): Promise<ToolResultMessage> {
	const updateEvents: Promise<void>[] = [];

	try {
		const result = await tool.execute(
			toolCall.id,
			args as Parameters<TTool["execute"]>[1],
			signal,
			(partialResult) => {
				updateEvents.push(
					Promise.resolve(
						emit({
							type: "tool_execution_update",
							toolCallId: toolCall.id,
							toolName: toolCall.name,
							args,
							partialResult,
						}),
					),
				);
			},
		);
		await Promise.all(updateEvents);

		return emitToolCallOutcome(toolCall, args, result, false, emit);
	} catch (error) {
		await Promise.all(updateEvents);
		return emitToolCallOutcome(
			toolCall,
			args,
			createErrorToolResult(error instanceof Error ? error.message : String(error)),
			true,
			emit,
		);
	}
}

function createErrorToolResult(message: string): AgentToolResult<{ message: string }> {
	return {
		content: [{ type: "text", text: message }],
		details: { message },
	};
}

async function emitToolCallOutcome(
	toolCall: AgentToolCall,
	args: unknown,
	result: AgentToolResult,
	isError: boolean,
	emit: AgentEventSink,
): Promise<ToolResultMessage> {
	await emit({
		type: "tool_execution_end",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		args,
		result,
		isError,
	});

	const toolResultMessage: ToolResultMessage = {
		role: "toolResult",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		content: result.content,
		isError,
		timestamp: Date.now(),
	};

	await emit({ type: "message_start", message: toolResultMessage });
	await emit({ type: "message_end", message: toolResultMessage });
	return toolResultMessage;
}
