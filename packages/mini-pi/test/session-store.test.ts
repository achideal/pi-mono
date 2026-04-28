/**
 * test/session-store.test.ts — Store + Backend 的测试（零 IO）。
 */

import { describe, expect, it } from "vitest";
import { InMemorySessionBackend, SessionStore } from "../src/session/index.js";

describe("SessionStore", () => {
	it("create/append/load round-trip via InMemoryBackend", async () => {
		const backend = new InMemorySessionBackend();
		const store = await SessionStore.create("/tmp/proj", backend);

		await store.appendMessage({ role: "user", content: "hello" });
		await store.appendMessage({ role: "assistant", content: "hi" });

		const reopened = await SessionStore.open(store.getId(), backend);
		expect(reopened.buildMessages()).toEqual([
			{ role: "user", content: "hello" },
			{ role: "assistant", content: "hi" },
		]);
	});

	it("buildMessages applies compaction: summary replaces pre-compaction messages", async () => {
		const backend = new InMemorySessionBackend();
		const store = await SessionStore.create("/tmp/proj", backend);

		// 先写 4 条消息
		await store.appendMessage({ role: "user", content: "m1" });
		await store.appendMessage({ role: "assistant", content: "m2" });
		await store.appendMessage({ role: "user", content: "m3" });
		const keepId = await store.appendMessage({ role: "assistant", content: "m4" });

		// 压缩：以 m4 为保留起点
		await store.appendCompaction("summary text", keepId, 999);

		// 再写 1 条新消息
		await store.appendMessage({ role: "user", content: "m5" });

		const msgs = store.buildMessages();
		// 预期：[summary-user, m4, m5]
		expect(msgs).toHaveLength(3);
		expect(msgs[0]).toMatchObject({ role: "user", content: expect.stringContaining("summary text") });
		expect(msgs[1]).toEqual({ role: "assistant", content: "m4" });
		expect(msgs[2]).toEqual({ role: "user", content: "m5" });
	});

	it("estimatedTokens is monotonic with message count", async () => {
		const backend = new InMemorySessionBackend();
		const store = await SessionStore.create("/tmp/proj", backend);

		const t0 = store.estimatedTokens();
		await store.appendMessage({ role: "user", content: "x".repeat(200) });
		const t1 = store.estimatedTokens();
		await store.appendMessage({ role: "assistant", content: "y".repeat(200) });
		const t2 = store.estimatedTokens();

		expect(t1).toBeGreaterThan(t0);
		expect(t2).toBeGreaterThan(t1);
	});
});
