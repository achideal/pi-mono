/**
 * session/types.ts — 会话持久化与压缩的契约。
 *
 * 【教学要点】
 * - SessionEntry 是 append-only 的（id/parentId 链表；branching 字段已预留但未用）
 * - SessionBackend 把文件系统抽象掉，允许替换成内存 / SQLite / IndexedDB
 * - CompactionPolicy 是策略，压缩**函数**本身是纯函数（DI 的 LLM 除外）
 */

import type { Message } from "../ai/index.js";

// ============================================================
// 1. 条目类型 — append-only，3 种就够
// ============================================================

export interface SessionEntryBase {
	id: string;
	parentId: string | null;
	timestamp: string;
}

/** 用户 / 助手 / 工具结果消息。 */
export interface MessageEntry extends SessionEntryBase {
	type: "message";
	message: Message;
}

/** 压缩摘要。压缩后，"buildMessages" 会用 summary 替代 firstKeptEntryId 之前的所有消息。 */
export interface CompactionEntry extends SessionEntryBase {
	type: "compaction";
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
}

/** 模型切换（教学版只为了展示"entries 不只是 message"）。 */
export interface ModelChangeEntry extends SessionEntryBase {
	type: "model_change";
	model: string;
}

export type SessionEntry = MessageEntry | CompactionEntry | ModelChangeEntry;

// ============================================================
// 2. 头部
// ============================================================

export interface SessionHeader {
	type: "session";
	version: 1;
	id: string;
	cwd: string;
	timestamp: string;
}

export type SessionFileRecord = SessionHeader | SessionEntry;

// ============================================================
// 3. 持久化后端（抽象）
// ============================================================

export interface SessionSummary {
	id: string;
	cwd: string;
	modified: Date;
	firstMessage: string;
	messageCount: number;
}

export interface SessionBackend {
	/** 读取指定会话的全部记录；不存在返回 null。 */
	load(id: string): Promise<SessionFileRecord[] | null>;

	/** 创建（或覆盖）头部。用于 newSession 时写首行。 */
	writeHeader(id: string, header: SessionHeader): Promise<void>;

	/** 追加一条 entry。实现可以选择批量缓冲再落盘。 */
	appendEntry(id: string, entry: SessionEntry): Promise<void>;

	/** 列出当前 cwd（或全局，取决于实现）下的会话。 */
	list(cwd: string): Promise<SessionSummary[]>;
}

// ============================================================
// 4. 压缩策略
// ============================================================

export interface CompactionPolicy {
	/**
	 * 是否需要压缩。`estimatedTokens` 是粗估值（字数 / 4）。
	 */
	shouldCompact(entries: readonly SessionEntry[], estimatedTokens: number): boolean;

	/** 压缩时保留最后多少条 message entry。 */
	keepTailCount: number;
}
