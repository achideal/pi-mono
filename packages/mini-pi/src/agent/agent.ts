/**
 * agent/agent.ts — 有状态外壳。
 *
 * 【教学要点】
 * Agent 是"长期存活"的对象，负责：
 *   - 持有 transcript（跨 prompt 调用存活）
 *   - 管理 listeners（事件订阅）
 *   - 管理 activeRun（并发锁 + abort controller）
 *   - 接收内核事件、聚合成可订阅的状态变更
 *
 * Agent 不做：
 *   - 协议推进（turn / tool loop） → 交给 agent-loop
 *   - 持久化 / 渲染 / 业务逻辑 → 交给订阅者（SessionStore、UI）
 *
 * 所以整个类只有 ~100 行：构造、prompt、abort、subscribe。
 */

import type { Message, StreamFn } from "../ai/index.js";
import type { Tool } from "../tools/index.js";
import { runAgentLoop } from "./agent-loop.js";
import type { AgentEvent, AgentEventSink, AgentLoopConfig } from "./types.js";

export interface AgentOptions {
	systemPrompt: string;
	tools: Tool[];
	model: string;
	apiKey: string;
	baseUrl?: string;
	streamFn: StreamFn;

	/** 从 session 恢复时传入历史消息。 */
	initialMessages?: Message[];

	/** 工具执行前/后的拦截钩子。 */
	beforeToolCall?: AgentLoopConfig["beforeToolCall"];
	afterToolCall?: AgentLoopConfig["afterToolCall"];

	/** 单次 prompt 最多允许多少轮 tool use。 */
	maxTurns?: number;
}

interface ActiveRun {
	controller: AbortController;
	promise: Promise<void>;
}

export class Agent {
	private messages: Message[];
	private readonly listeners = new Set<AgentEventSink>();
	private activeRun: ActiveRun | undefined;

	constructor(private readonly options: AgentOptions) {
		this.messages = [...(options.initialMessages ?? [])];
	}

	// ============================================================
	// 订阅接口
	// ============================================================

	subscribe(listener: AgentEventSink): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	// ============================================================
	// 查询接口（只读快照）
	// ============================================================

	getMessages(): readonly Message[] {
		return this.messages;
	}

	isRunning(): boolean {
		return this.activeRun !== undefined;
	}

	// ============================================================
	// 控制接口
	// ============================================================

	/** 中止当前运行。若没有活跃运行则无事发生。 */
	abort(): void {
		this.activeRun?.controller.abort();
	}

	/**
	 * 外部（如压缩流程）替换整个 transcript。
	 * 运行时调用会抛异常 —— 保护内核持有的快照一致性。
	 */
	replaceTranscript(messages: Message[]): void {
		if (this.activeRun) {
			throw new Error("Cannot replace transcript during an active run.");
		}
		this.messages = [...messages];
	}

	/**
	 * 发起一次对话。
	 * - 并发保护：运行中再调会抛错
	 * - 事件聚合：内核事件 → 更新内部 messages + 广播给订阅者
	 */
	async prompt(text: string): Promise<void> {
		if (this.activeRun) {
			throw new Error("Agent is already processing a prompt.");
		}

		const userMessage: Message = { role: "user", content: text };

		const controller = new AbortController();
		let resolveRun = (): void => {};
		const promise = new Promise<void>((r) => {
			resolveRun = r;
		});
		this.activeRun = { controller, promise };

		const emit = async (event: AgentEvent): Promise<void> => {
			// 状态聚合：内核只会在 message_end 发出**完整**消息；Agent 只在这一点更新 transcript。
			// text_delta / tool_start / tool_end 只是"流式反馈"，不改变 transcript。
			//
			// 注意：message_end 包含的 user message 是我们自己刚才构造的 —— 也会在这里被追加。
			if (event.type === "message_end") {
				this.messages.push(event.message);
			}

			// 广播（串行，便于订阅者做 async 操作，如磁盘 append）
			for (const listener of this.listeners) {
				try {
					await listener(event);
				} catch {
					// 订阅者错误不应该打断流。吃掉。
				}
			}
		};

		const config: AgentLoopConfig = {
			model: this.options.model,
			apiKey: this.options.apiKey,
			baseUrl: this.options.baseUrl,
			streamFn: this.options.streamFn,
			beforeToolCall: this.options.beforeToolCall,
			afterToolCall: this.options.afterToolCall,
			maxTurns: this.options.maxTurns,
		};

		try {
			await runAgentLoop(
				[userMessage],
				{
					systemPrompt: this.options.systemPrompt,
					messages: [...this.messages],
					tools: this.options.tools,
				},
				config,
				emit,
				controller.signal,
			);
		} finally {
			this.activeRun = undefined;
			resolveRun();
		}

		await promise; // 让调用方 await 到真正结束
	}
}
