import type { AIClient } from "../ai/index.js";
import type { Message, SessionManager } from "./types.js";

const TOKEN_LIMIT = 100000;
const COMPACTION_THRESHOLD = 0.8;

export function estimateTokens(text: string): number {
	// Rough estimate: ~4 characters per token
	return Math.ceil(text.length / 4);
}

export function countMessagesTokens(messages: Message[]): number {
	let total = 0;
	for (const msg of messages) {
		total += estimateTokens(msg.content);
		if (msg.toolCalls) {
			for (const tc of msg.toolCalls) {
				total += estimateTokens(tc.name) + estimateTokens(tc.arguments);
			}
		}
	}
	return total;
}

export function shouldCompact(session: SessionManager): boolean {
	const messages = session.getBranch();
	const tokens = countMessagesTokens(messages);
	return tokens > TOKEN_LIMIT * COMPACTION_THRESHOLD;
}

export function findCutPoint(messages: Message[]): number {
	// Find a good cut point after the last user message
	// that leaves at least 10 messages
	const minMessages = 10;
	if (messages.length <= minMessages) {
		return -1;
	}

	// Look for a compaction entry or find midpoint
	for (let i = messages.length - minMessages - 1; i >= 0; i--) {
		if (messages[i].content.includes("---") || messages[i].content.includes("## ")) {
			return i;
		}
	}

	// Default to first third
	return Math.floor(messages.length / 3);
}

export async function compact(session: SessionManager, aiClient: AIClient): Promise<void> {
	const messages = session.getBranch();
	const cutPoint = findCutPoint(messages);

	if (cutPoint <= 0) {
		return; // Not enough to compact
	}

	const toCompact = messages.slice(0, cutPoint);
	const summary = await generateSummary(toCompact, aiClient);

	// Create compaction entry
	const entries = session.export();
	const oldestEntry = entries.find((e) => e.type === "message");

	if (oldestEntry) {
		session.append({
			type: "compaction",
			parentId: null, // Compaction is a root-like entry
			data: {
				summary,
				entryCount: toCompact.length,
			},
		});
	}
}

async function generateSummary(messages: Message[], aiClient: AIClient): Promise<string> {
	const prompt = `Summarize the following conversation concisely:

${messages.map((m) => `${m.role}: ${m.content}`).join("\n\n")}

Summary:`;

	try {
		const result = await aiClient.complete([{ role: "user", content: prompt }], []);
		return result.content.trim();
	} catch {
		// Fallback to simple summary
		return `Conversation with ${messages.length} messages`;
	}
}
