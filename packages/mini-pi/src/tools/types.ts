/**
 * tools/types.ts — 工具的协议契约。
 *
 * 【教学要点】
 * Tool 是"接口"而非"基类"。实现者无需继承任何东西，满足结构即可。
 * 这就是 TypeScript 结构化类型（duck typing）带来的自由度。
 *
 * Tool 被 agent-loop（内核）按名字查找并调用，agent-loop 不 import 具体工具。
 * 这是**依赖倒置**的经典应用：内核依赖 `Tool` 抽象，具体工具由外部注入。
 */

import type { ToolSchema } from "../ai/index.js";

export interface ToolResult {
	/** 给 LLM 看的字符串结果。二进制/图片等教学版不支持。 */
	output: string;
	isError?: boolean;
}

export interface Tool<Args extends Record<string, unknown> = Record<string, unknown>> {
	/** 给 LLM 的工具描述（name / description / JSON schema）。 */
	schema: ToolSchema;
	/**
	 * 执行工具。
	 * @param args  已经通过 schema 校验的参数
	 * @param signal  取消信号；长耗时工具必须监听
	 */
	execute(args: Args, signal?: AbortSignal): Promise<ToolResult>;
}
