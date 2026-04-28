/**
 * test/agent.test.ts — 外壳的测试（不用真 LLM）。
 */

import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../src/agent/index.js";
import { Agent } from "../src/agent/index.js";
import { createFauxProvider, textReply } from "./faux-provider.js";

describe("Agent", () => {
	it("appends transcript on message_end events", async () => {
		const faux = createFauxProvider([textReply("hello back")]);
		const agent = new Agent({
			systemPrompt: "sys",
			tools: [],
			model: "m",
			apiKey: "k",
			streamFn: faux.streamFn,
		});

		await agent.prompt("hi");
		const msgs = agent.getMessages();

		// user + assistant
		expect(msgs).toHaveLength(2);
		expect(msgs[0]).toEqual({ role: "user", content: "hi" });
		expect(msgs[1]).toMatchObject({ role: "assistant", content: "hello back" });
	});

	it("broadcasts events to listeners in subscribe order", async () => {
		const faux = createFauxProvider([textReply("ok")]);
		const agent = new Agent({ systemPrompt: "", tools: [], model: "m", apiKey: "k", streamFn: faux.streamFn });

		const received: AgentEvent[] = [];
		agent.subscribe((e) => void received.push(e));

		await agent.prompt("go");
		expect(received.some((e) => e.type === "agent_start")).toBe(true);
		expect(received.at(-1)?.type).toBe("agent_end");
	});

	it("forbids concurrent prompts", async () => {
		const faux = createFauxProvider([textReply("ok"), textReply("ok2")]);
		const agent = new Agent({ systemPrompt: "", tools: [], model: "m", apiKey: "k", streamFn: faux.streamFn });

		const p = agent.prompt("first");
		await expect(agent.prompt("second")).rejects.toThrow(/already processing/);
		await p;
	});

	it("replaceTranscript throws during active run", async () => {
		// 构造一个会暂停的 provider
		let resolveWait: () => void = () => {};
		const provider = {
			streamFn: async function* () {
				yield { type: "text_delta" as const, text: "..." };
				await new Promise<void>((r) => {
					resolveWait = r;
				});
				yield { type: "done" as const, stopReason: "stop" as const };
			},
		};

		const agent = new Agent({
			systemPrompt: "",
			tools: [],
			model: "m",
			apiKey: "k",
			streamFn: provider.streamFn,
		});

		const promptPromise = agent.prompt("go");
		// 等 loop 真正启动
		await new Promise((r) => setTimeout(r, 10));
		expect(() => agent.replaceTranscript([])).toThrow(/during an active run/);
		resolveWait();
		await promptPromise;

		// 结束后可以 replace
		expect(() => agent.replaceTranscript([])).not.toThrow();
	});
});
