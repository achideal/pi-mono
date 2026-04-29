/**
 * agent/agent-loop.ts — 无长期状态的协议推进内核。
 *
 * 【教学要点】—— 这是 mini-pi 最重要的一个文件，请仔细阅读对应的 README。
 *
 * 纪律（以下四条是硬性约束）：
 *   1. 不使用 class / this —— 只用顶层 async function
 *   2. 不使用模块级可变变量 —— 所有状态都是函数局部变量
 *   3. 不 import 任何外壳 / UI / session / CLI 代码 —— 只依赖 ai / tools 层
 *   4. 所有依赖都从参数传入 —— streamFn / tools / hooks / emit 全部 DI
 *
 * 主流程：
 *   runAgentLoop 是唯一公共入口。它接收"本次 run 的全部输入"，内部驱动：
 *     while (还有工具调用要继续):
 *       调 LLM → 累积 assistant message
 *       如果有 tool_call：逐个校验、调 hook、执行、回填 result
 *       否则结束
 *
 * 返回值：本次 run 新增的全部消息（纯数据），由外壳决定要不要持久化。
 */

import type { Message, ToolCall, ToolResultMessage } from "../ai/index.js";
import { type Tool, type ToolResult, validateToolArguments } from "../tools/index.js";
import type { AgentContext, AgentEventSink, AgentLoopConfig } from "./types.js";

const DEFAULT_MAX_TURNS = 20;

/**
 * 驱动一次 agent 对话。
 *
 * @param newUserMessages  本轮用户输入（通常是 1 条 user 消息）
 * @param context          当前会话上下文快照（transcript + tools + systemPrompt）
 * @param config           策略 + 依赖（LLM / hooks）
 * @param emit             反向回调：把内核事件丢给外壳
 * @param signal           取消信号
 * @returns 本次 run 新增的全部消息（user + assistant + tool result）
 */
export async function runAgentLoop(
	newUserMessages: Message[],
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal?: AbortSignal,
): Promise<Message[]> {
	const newMessages: Message[] = [];
	const workingMessages: Message[] = [...context.messages, ...newUserMessages];

	// 把新的 user 消息先记账。
	// 注意：user message 不是流式生成的，因此只发 message_end，不发 message_start。
	// 语义约定：message_start 只标记"一个流式 assistant 输出即将开始"。
	for (const m of newUserMessages) {
		newMessages.push(m);
		await emit({ type: "message_end", message: m });
	}

	await emit({ type: "agent_start" });

	const maxTurns = config.maxTurns ?? DEFAULT_MAX_TURNS;
	let turn = 0;

	try {
		while (true) {
			if (signal?.aborted) {
				await emit({ type: "agent_end", reason: "aborted" });
				return newMessages;
			}
			if (turn >= maxTurns) {
				await emit({ type: "agent_end", reason: "max_turns" });
				return newMessages;
			}

			turn++;
			await emit({ type: "turn_start", turn });

			// ========== 1. 调 LLM ==========
			const assistantResult = await consumeLlmStream(
				workingMessages,
				context.systemPrompt,
				context.tools,
				config,
				emit,
				signal,
			);

			if (assistantResult.stopReason === "error") {
				workingMessages.push(assistantResult.message);
				newMessages.push(assistantResult.message);
				await emit({ type: "turn_end", turn });
				await emit({ type: "agent_end", reason: "error", error: assistantResult.error });
				return newMessages;
			}
			if (assistantResult.stopReason === "aborted") {
				await emit({ type: "turn_end", turn });
				await emit({ type: "agent_end", reason: "aborted" });
				return newMessages;
			}

			workingMessages.push(assistantResult.message);
			newMessages.push(assistantResult.message);

			// ========== 2. 有没有 tool call？没有就结束 ==========
			const toolCalls = assistantResult.message.toolCalls ?? [];
			if (toolCalls.length === 0) {
				await emit({ type: "turn_end", turn });
				await emit({ type: "agent_end", reason: "stop" });
				return newMessages;
			}

			// ========== 3. 逐个执行工具 ==========
			for (const call of toolCalls) {
				if (signal?.aborted) {
					await emit({ type: "turn_end", turn });
					await emit({ type: "agent_end", reason: "aborted" });
					return newMessages;
				}

				await emit({ type: "tool_start", call });
				const result = await executeToolCall(call, context.tools, config, signal);
				const toolMessage: ToolResultMessage = {
					role: "tool",
					toolCallId: call.id,
					content: result.output,
				};
				workingMessages.push(toolMessage);
				newMessages.push(toolMessage);

				await emit({ type: "tool_end", callId: call.id, result });
				// 把 tool result 也作为 message_end 广播一次，让 transcript 订阅者统一处理
				await emit({ type: "message_end", message: toolMessage });
			}

			await emit({ type: "turn_end", turn });
			// 继续下一轮（让 LLM 看到工具结果后再回话）
		}
	} catch (err) {
		const aborted = signal?.aborted === true || (err as { name?: string }).name === "AbortError";
		await emit({
			type: "agent_end",
			reason: aborted ? "aborted" : "error",
			error: aborted ? undefined : String(err),
		});
		return newMessages;
	}
}

// ============================================================
// 内部辅助：消费 LLM 流 → 累积成一条 AssistantMessage
// ============================================================

interface LlmStreamResult {
	message: Message & { role: "assistant" };
	stopReason: "stop" | "tool_use" | "aborted" | "error";
	error?: string;
}

async function consumeLlmStream(
	messages: Message[],
	systemPrompt: string,
	tools: Tool[],
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal?: AbortSignal,
): Promise<LlmStreamResult> {
	await emit({ type: "message_start" });

	let text = "";
	const toolCalls: ToolCall[] = [];
	let stopReason: LlmStreamResult["stopReason"] = "stop";
	let error: string | undefined;

	const llmTools = tools.map((t) => t.schema);
	const llmMessages: Message[] = systemPrompt ? [{ role: "system", content: systemPrompt }, ...messages] : messages;

	const stream = config.streamFn(llmMessages, llmTools, {
		apiKey: config.apiKey,
		model: config.model,
		baseUrl: config.baseUrl,
		signal,
	});

	for await (const event of stream) {
		if (event.type === "text_delta") {
			text += event.text;
			await emit({ type: "text_delta", text: event.text });
			continue;
		}
		if (event.type === "tool_call") {
			toolCalls.push(event.call);
			continue;
		}
		if (event.type === "done") {
			stopReason = event.stopReason;
			error = event.error;
			break;
		}
	}

	const message: LlmStreamResult["message"] = {
		role: "assistant",
		content: text,
		toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
	};
	await emit({ type: "message_end", message });

	return { message, stopReason, error };
}

// ============================================================
// 内部辅助：执行一个 tool_call（含校验、hook、错误处理）
// ============================================================

async function executeToolCall(
	call: ToolCall,
	tools: Tool[],
	config: AgentLoopConfig,
	signal?: AbortSignal,
): Promise<ToolResult> {
	const tool = tools.find((t) => t.schema.name === call.name);
	if (!tool) {
		return { output: `Tool not found: ${call.name}`, isError: true };
	}

	// 校验参数
	const validation = validateToolArguments(tool.schema, call.arguments);
	if (validation) {
		return { output: validation.message, isError: true };
	}

	// before hook
	if (config.beforeToolCall) {
		const decision = await config.beforeToolCall(call);
		if (decision?.block) {
			return { output: decision.reason ?? "Tool execution blocked", isError: true };
		}
	}

	// 执行
	let result: ToolResult;
	try {
		result = await tool.execute(call.arguments, signal);
	} catch (err) {
		result = { output: `Tool threw: ${(err as Error).message}`, isError: true };
	}

	// after hook
	if (config.afterToolCall) {
		result = await config.afterToolCall(call, result);
	}

	return result;
}
