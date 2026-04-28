/**
 * session/session-store.ts — 会话有状态协作者。
 *
 * 【教学要点】
 * SessionStore 与 Agent **平级**，不是 Agent 的成员。
 * Agent 完全不知道 Store 存在 —— Store 通过 `attachTo(agent)` 订阅事件自主落盘。
 *
 * Store 的职责：
 *  - 读写 entries（通过 SessionBackend 抽象）
 *  - 维护 leaf 指针（链表位置）
 *  - 用 buildMessages() 重建给 LLM 的 transcript（处理 compaction）
 *
 * Store 不做：
 *  - 触发压缩（由上层 Composition Root 协调）
 *  - 和 Agent 直接通信（只通过事件订阅）
 */

import { randomUUID } from "node:crypto";
import type { Agent, AgentEvent } from "../agent/index.js";
import type { Message } from "../ai/index.js";
import type {
	CompactionEntry,
	MessageEntry,
	SessionBackend,
	SessionEntry,
	SessionFileRecord,
	SessionHeader,
} from "./types.js";

function nowIso(): string {
	return new Date().toISOString();
}

function generateId(existing: Set<string>): string {
	for (let i = 0; i < 100; i++) {
		const id = randomUUID().slice(0, 8);
		if (!existing.has(id)) return id;
	}
	return randomUUID();
}

export class SessionStore {
	private header: SessionHeader;
	private entries: SessionEntry[] = [];
	private byId = new Map<string, SessionEntry>();
	private leafId: string | null = null;

	private constructor(
		header: SessionHeader,
		private readonly backend: SessionBackend,
	) {
		this.header = header;
	}

	// ============================================================
	// 工厂
	// ============================================================

	static async create(cwd: string, backend: SessionBackend): Promise<SessionStore> {
		const id = randomUUID();
		const header: SessionHeader = {
			type: "session",
			version: 1,
			id,
			cwd,
			timestamp: nowIso(),
		};
		await backend.writeHeader(id, header);
		return new SessionStore(header, backend);
	}

	static async open(id: string, backend: SessionBackend): Promise<SessionStore> {
		const records = await backend.load(id);
		if (!records || records.length === 0) {
			throw new Error(`Session ${id} not found or empty`);
		}
		const header = records.find((r): r is SessionHeader => r.type === "session");
		if (!header) throw new Error(`Session ${id} missing header`);

		const store = new SessionStore(header, backend);
		for (const rec of records) {
			if (rec.type !== "session") {
				store.entries.push(rec);
				store.byId.set(rec.id, rec);
				store.leafId = rec.id;
			}
		}
		return store;
	}

	// ============================================================
	// 查询
	// ============================================================

	getId(): string {
		return this.header.id;
	}

	getCwd(): string {
		return this.header.cwd;
	}

	getLeafId(): string | null {
		return this.leafId;
	}

	getEntries(): readonly SessionEntry[] {
		return this.entries;
	}

	/**
	 * 重建给 LLM 看的 transcript。
	 * - 无压缩：返回所有 message 消息
	 * - 有压缩：返回 "[summary] + firstKeptEntryId 之后的 messages"
	 */
	buildMessages(): Message[] {
		const latestCompaction = this.findLatestCompaction();
		if (!latestCompaction) {
			return this.entries.filter((e): e is MessageEntry => e.type === "message").map((e) => e.message);
		}

		const idx = this.entries.findIndex((e) => e.id === latestCompaction.id);
		const kept: Message[] = [];
		let foundStart = false;
		for (let i = 0; i < idx; i++) {
			const e = this.entries[i];
			if (e.id === latestCompaction.firstKeptEntryId) foundStart = true;
			if (foundStart && e.type === "message") kept.push(e.message);
		}
		for (let i = idx + 1; i < this.entries.length; i++) {
			const e = this.entries[i];
			if (e.type === "message") kept.push(e.message);
		}

		const summaryMessage: Message = {
			role: "user",
			content: `[Previous conversation summary]\n${latestCompaction.summary}`,
		};
		return [summaryMessage, ...kept];
	}

	private findLatestCompaction(): CompactionEntry | undefined {
		for (let i = this.entries.length - 1; i >= 0; i--) {
			const e = this.entries[i];
			if (e.type === "compaction") return e;
		}
		return undefined;
	}

	/** 粗估 tokens：每 4 字符算 1 token。教学用。 */
	estimatedTokens(): number {
		let chars = 0;
		for (const e of this.entries) {
			if (e.type === "message") {
				chars += JSON.stringify(e.message).length;
			}
		}
		return Math.ceil(chars / 4);
	}

	// ============================================================
	// 追加（append-only）
	// ============================================================

	async appendMessage(message: Message): Promise<string> {
		return this.appendEntryOf({ type: "message", message });
	}

	async appendCompaction(summary: string, firstKeptEntryId: string, tokensBefore: number): Promise<string> {
		return this.appendEntryOf({
			type: "compaction",
			summary,
			firstKeptEntryId,
			tokensBefore,
		});
	}

	async appendModelChange(model: string): Promise<string> {
		return this.appendEntryOf({ type: "model_change", model });
	}

	private async appendEntryOf(
		partial:
			| { type: "message"; message: MessageEntry["message"] }
			| { type: "compaction"; summary: string; firstKeptEntryId: string; tokensBefore: number }
			| { type: "model_change"; model: string },
	): Promise<string> {
		const id = generateId(new Set(this.byId.keys()));
		const base = { id, parentId: this.leafId, timestamp: nowIso() };
		const entry: SessionEntry = { ...partial, ...base } as SessionEntry;
		this.entries.push(entry);
		this.byId.set(id, entry);
		this.leafId = id;
		await this.backend.appendEntry(this.header.id, entry);
		return id;
	}

	// ============================================================
	// 订阅 Agent 事件 → 自动落盘
	// ============================================================

	/**
	 * 订阅 Agent 的 message_end 事件，把每条完整消息追加为 MessageEntry。
	 * 返回 unsubscribe 函数。
	 *
	 * 设计要点：
	 * - 只听 message_end（流式 delta 不落盘）
	 * - 错误是 swallow 的，避免影响 Agent 主流程
	 */
	attachTo(agent: Agent): () => void {
		return agent.subscribe(async (event: AgentEvent) => {
			if (event.type !== "message_end") return;
			try {
				await this.appendMessage(event.message);
			} catch (err) {
				// 落盘失败不应影响运行时；真实项目里应该打 metric
				console.error("[SessionStore] appendMessage failed:", err);
			}
		});
	}

	// ============================================================
	// 列表
	// ============================================================

	static async list(cwd: string, backend: SessionBackend) {
		return backend.list(cwd);
	}
}

// ============================================================
// 导出 record 写盘辅助，供外部（例如测试）构造初始状态
// ============================================================

export function isSessionHeader(rec: SessionFileRecord): rec is SessionHeader {
	return rec.type === "session";
}
