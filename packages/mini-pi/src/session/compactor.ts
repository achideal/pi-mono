/**
 * session/compactor.ts — 上下文压缩策略与执行函数。
 *
 * 【教学要点】
 * compact() 是一个**无状态函数**（把策略、输入、LLM 全部当参数）。
 * 它不属于 SessionStore 的方法，因为压缩需要调 LLM，而 Store 不应该持有 LLM 能力。
 *
 * 压缩的触发时机**不在这个文件决定** —— 由上层 Composition Root 负责：
 *   "我觉得该压了 → 调 compact() → 拿到结果 → 往 Store 里 append → 让 Agent replaceTranscript"
 *
 * 这种"跨组件事务放在 Composition Root"的原则让 Compactor 极度单纯。
 */

import type { Message, StreamFn } from "../ai/index.js";
import type { CompactionPolicy, MessageEntry, SessionEntry } from "./types.js";

export const DEFAULT_COMPACTION_POLICY: CompactionPolicy = {
	shouldCompact: (_entries, estimatedTokens) => estimatedTokens > 30_000,
	keepTailCount: 6,
};

export interface CompactionResult {
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
}

export interface CompactionRequest {
	entries: readonly SessionEntry[];
	policy: CompactionPolicy;
	streamFn: StreamFn;
	apiKey: string;
	model: string;
	baseUrl?: string;
	signal?: AbortSignal;
}

/**
 * 生成一次压缩结果。若策略判断不需要压缩，返回 null。
 *
 * 成功时：
 *  - 调一次 LLM 生成摘要
 *  - 返回 "summary / 保留起点 id / 压缩前估算 tokens"
 */
export async function compact(req: CompactionRequest): Promise<CompactionResult | null> {
	const messageEntries = req.entries.filter((e): e is MessageEntry => e.type === "message");

	const estimatedTokens = Math.ceil(messageEntries.reduce((s, e) => s + JSON.stringify(e.message).length, 0) / 4);

	if (!req.policy.shouldCompact(req.entries, estimatedTokens)) {
		return null;
	}

	if (messageEntries.length <= req.policy.keepTailCount) {
		return null; // 消息还没多到可压
	}

	const keep = messageEntries.slice(-req.policy.keepTailCount);
	const toSummarize = messageEntries.slice(0, messageEntries.length - req.policy.keepTailCount);

	const summary = await askSummary(
		toSummarize.map((e) => e.message),
		req,
	);
	if (!summary) return null;

	return {
		summary,
		firstKeptEntryId: keep[0].id,
		tokensBefore: estimatedTokens,
	};
}

async function askSummary(history: Message[], req: CompactionRequest): Promise<string> {
	const instruction: Message = {
		role: "system",
		content:
			"You are a conversation summarizer. Produce a concise summary that preserves: " +
			"(1) user intents, (2) key decisions, (3) file paths / code symbols referenced, " +
			"(4) outstanding TODOs. Output plain text, no markdown headings.",
	};
	const prompt: Message = {
		role: "user",
		content: "Summarize the preceding conversation following the instruction above.",
	};

	let summary = "";
	const stream = req.streamFn([instruction, ...history, prompt], [], {
		apiKey: req.apiKey,
		model: req.model,
		baseUrl: req.baseUrl,
		signal: req.signal,
	});

	for await (const event of stream) {
		if (event.type === "text_delta") summary += event.text;
		if (event.type === "done" && event.stopReason !== "stop") {
			return ""; // 失败/中止就不压了
		}
	}
	return summary.trim();
}
