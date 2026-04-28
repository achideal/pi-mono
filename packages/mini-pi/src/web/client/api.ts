/**
 * web/client/api.ts — 前端调用后端的封装。
 *
 * 只是几行 fetch，但是**通过共享类型**避免了契约不一致。
 */

import type {
	CreateSessionResponse,
	ListSessionsResponse,
	OpenSessionResponse,
	PromptRequest,
	ServerEvent,
} from "../api.js";

export async function listSessions(): Promise<ListSessionsResponse> {
	const r = await fetch("/api/sessions");
	return r.json();
}

export async function createSession(): Promise<CreateSessionResponse> {
	const r = await fetch("/api/sessions", { method: "POST" });
	return r.json();
}

export async function openSession(id: string): Promise<OpenSessionResponse> {
	const r = await fetch(`/api/sessions/${encodeURIComponent(id)}`);
	return r.json();
}

export async function sendPrompt(sessionId: string, text: string): Promise<void> {
	const body: PromptRequest = { sessionId, text };
	await fetch("/api/prompt", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

export async function abortRun(sessionId: string): Promise<void> {
	await fetch("/api/abort", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ sessionId }),
	});
}

export function subscribeEvents(sessionId: string, onEvent: (event: ServerEvent) => void): () => void {
	const es = new EventSource(`/api/events?sessionId=${encodeURIComponent(sessionId)}`);
	es.onmessage = (msg) => {
		try {
			onEvent(JSON.parse(msg.data) as ServerEvent);
		} catch {
			// ignore
		}
	};
	return () => es.close();
}
