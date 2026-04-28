/**
 * ai/provider-factory.ts — 选择 provider 的装配点。
 *
 * 故意没有做成"注册表模式"（Map<name, StreamFn>）：
 * - 教学项目只需要 2 个 provider，if/else 比注册表更清晰
 * - 注册表是"解耦"的错觉：它只是把 switch 从一个文件搬到"注册"的调用处
 * - 真需要插件化时（比如 pi-mono 的 api-registry），再升级也不迟
 *
 * 这里体现的原则：**不要预先抽象**（YAGNI）。让当前代码的清晰度胜过假想的扩展性。
 */

import { streamChatCompletions } from "./chat-completions.js";
import { streamResponses } from "./responses.js";
import type { StreamFn } from "./types.js";

export type ProviderKind = "chat-completions" | "responses";

export function pickProvider(kind: ProviderKind): StreamFn {
	switch (kind) {
		case "chat-completions":
			return streamChatCompletions;
		case "responses":
			return streamResponses;
	}
}
