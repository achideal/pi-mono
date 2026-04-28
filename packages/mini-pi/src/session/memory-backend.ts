/**
 * session/memory-backend.ts — 内存后端（测试与浏览器用）。
 *
 * 教学意义：证明 SessionBackend 是**真正的抽象** ——
 * 换一个 0-IO 实现，Store / Compactor 一行代码不改。
 */

import type { SessionBackend, SessionEntry, SessionFileRecord, SessionHeader, SessionSummary } from "./types.js";

export class InMemorySessionBackend implements SessionBackend {
	private readonly store = new Map<string, SessionFileRecord[]>();

	async load(id: string): Promise<SessionFileRecord[] | null> {
		const records = this.store.get(id);
		return records ? [...records] : null;
	}

	async writeHeader(id: string, header: SessionHeader): Promise<void> {
		this.store.set(id, [header]);
	}

	async appendEntry(id: string, entry: SessionEntry): Promise<void> {
		const records = this.store.get(id);
		if (!records) throw new Error(`Session ${id} has no header`);
		records.push(entry);
	}

	async list(cwd: string): Promise<SessionSummary[]> {
		const out: SessionSummary[] = [];
		for (const [id, records] of this.store) {
			const header = records.find((r) => r.type === "session");
			if (!header || header.cwd !== cwd) continue;
			const msgs = records.filter((r): r is SessionEntry & { type: "message" } => r.type === "message");
			const first = msgs.find((m) => m.message.role === "user");
			out.push({
				id,
				cwd: header.cwd,
				modified: new Date(header.timestamp),
				firstMessage: first?.message.role === "user" ? first.message.content : "",
				messageCount: msgs.length,
			});
		}
		return out;
	}
}
