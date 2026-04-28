/**
 * web/event-hub.ts — 一个最简的 SSE 事件总线。
 *
 * 允许多个 HTTP SSE 连接订阅同一个 sessionId 的事件。
 *
 * 教学价值：展示 "事件驱动 UI 的最小骨架" —— 前后端之间只有两条通道：
 *   1. POST /prompt（触发 action）
 *   2. GET /events?sessionId=xxx（订阅事件）
 * 没有 WebSocket 的复杂性。
 */

import type { ServerResponse } from "node:http";
import type { ServerEvent } from "./api.js";

export class EventHub {
	/** sessionId → 订阅者集合 */
	private readonly subs = new Map<string, Set<ServerResponse>>();

	subscribe(sessionId: string, res: ServerResponse): void {
		let set = this.subs.get(sessionId);
		if (!set) {
			set = new Set();
			this.subs.set(sessionId, set);
		}
		set.add(res);

		res.on("close", () => {
			set?.delete(res);
			if (set && set.size === 0) this.subs.delete(sessionId);
		});

		// 立刻发一条 info，让前端知道已连接
		this.writeTo(res, { kind: "info", message: "connected" });
	}

	publish(sessionId: string, event: ServerEvent): void {
		const set = this.subs.get(sessionId);
		if (!set) return;
		for (const res of set) {
			this.writeTo(res, event);
		}
	}

	private writeTo(res: ServerResponse, event: ServerEvent): void {
		try {
			res.write(`data: ${JSON.stringify(event)}\n\n`);
		} catch {
			// 客户端已断开，下一个 tick 会被 close 清理
		}
	}
}
