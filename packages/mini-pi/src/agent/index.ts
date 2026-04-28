/**
 * agent 层公共导出。
 *
 * 对外暴露：
 * - Agent 类（外壳）
 * - runAgentLoop 函数（内核）—— 允许不使用 Agent 也能直接跑 loop
 * - 所有公共类型
 */

export { Agent, type AgentOptions } from "./agent.js";
export { runAgentLoop } from "./agent-loop.js";
export type {
	AgentContext,
	AgentEvent,
	AgentEventSink,
	AgentLoopConfig,
	BeforeToolCallResult,
} from "./types.js";
