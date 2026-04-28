/**
 * test/integration.test.ts — Agent + SessionStore 端到端协作测试。
 *
 * 验证：
 * - store.attachTo(agent) 能让消息自动落盘
 * - prompt 后 session 里有正确的 entries
 * - buildMessages 能 round-trip
 */

import { describe, expect, it } from "vitest";
import { Agent } from "../src/agent/index.js";
import { InMemorySessionBackend, SessionStore } from "../src/session/index.js";
import { createFauxProvider, textReply } from "./faux-provider.js";

describe("Integration: Agent + SessionStore", () => {
	it("attachTo persists messages automatically", async () => {
		const backend = new InMemorySessionBackend();
		const store = await SessionStore.create("/tmp/proj", backend);

		const faux = createFauxProvider([textReply("hi there")]);
		const agent = new Agent({
			systemPrompt: "",
			tools: [],
			model: "m",
			apiKey: "k",
			streamFn: faux.streamFn,
		});
		const unsubscribe = store.attachTo(agent);

		await agent.prompt("hello");

		const messages = store.buildMessages();
		expect(messages).toEqual([
			{ role: "user", content: "hello" },
			{ role: "assistant", content: "hi there" },
		]);

		unsubscribe();
	});

	it("reopening session preserves transcript", async () => {
		const backend = new InMemorySessionBackend();
		const store1 = await SessionStore.create("/tmp/proj", backend);
		const faux = createFauxProvider([textReply("reply"), textReply("follow up")]);
		const agent1 = new Agent({
			systemPrompt: "",
			tools: [],
			model: "m",
			apiKey: "k",
			streamFn: faux.streamFn,
		});
		store1.attachTo(agent1);
		await agent1.prompt("q1");

		// 新开一个 Store 指向同一 backend
		const store2 = await SessionStore.open(store1.getId(), backend);
		expect(store2.buildMessages()).toEqual(store1.buildMessages());

		// 在重建的 Agent 上继续对话
		const agent2 = new Agent({
			systemPrompt: "",
			tools: [],
			model: "m",
			apiKey: "k",
			streamFn: faux.streamFn,
			initialMessages: [...store2.buildMessages()],
		});
		store2.attachTo(agent2);
		await agent2.prompt("q2");

		expect(store2.buildMessages()).toEqual([
			{ role: "user", content: "q1" },
			{ role: "assistant", content: "reply" },
			{ role: "user", content: "q2" },
			{ role: "assistant", content: "follow up" },
		]);
	});
});
