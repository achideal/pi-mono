/**
 * ai/sse.ts — 极简 SSE 行级解析器。
 *
 * OpenAI 两种协议（chat.completions stream 和 responses stream）都走 SSE。
 * 这里提供一个共享的解析，供两个 provider 复用。
 *
 * 本实现：
 * - 只解析 `data: ...` 行
 * - 遇到 `data: [DONE]` 结束
 * - 忽略 event: / id: / retry: 等字段（OpenAI data-only 流不使用）
 *
 * 教学意义：让学习者看清 "SSE = 基于换行的文本协议"，不依赖任何 SSE 客户端库。
 */

export async function* parseSseStream(response: Response, signal?: AbortSignal): AsyncGenerator<unknown> {
	if (!response.ok) {
		const text = await response.text();
		throw new Error(`HTTP ${response.status}: ${text}`);
	}
	if (!response.body) {
		throw new Error("Response has no body");
	}

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	try {
		while (true) {
			if (signal?.aborted) return;
			const { done, value } = await reader.read();
			if (done) break;

			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? ""; // 最后一行可能不完整，留到下一轮

			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed.startsWith("data:")) continue;
				const payload = trimmed.slice(5).trim();
				if (payload === "[DONE]") return;
				if (!payload) continue;
				try {
					yield JSON.parse(payload);
				} catch {
					// 忽略无法解析的分片（某些网关会插入心跳）
				}
			}
		}
	} finally {
		reader.releaseLock();
	}
}
