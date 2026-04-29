/**
 * web/client/App.tsx — mini-pi 主界面。
 *
 * 教学要点：
 *  - 状态管理全用 React hooks，不引入 Redux/Zustand
 *  - 事件消费：从 SSE 收到 AgentEvent 后 reduce 到本地 state
 *  - UI 由 state 派生；reduce 函数 = "事件 → state" 的映射，很容易测
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SessionSummary } from "../../session/index.js";
import type { ServerEvent } from "../api.js";
import { abortRun, createSession, listSessions, openSession, sendPrompt, subscribeEvents } from "./api.js";

// ============================================================
// 视图模型
// ============================================================

interface DisplayMessage {
	id: string;
	role: "user" | "assistant" | "tool";
	content: string;
	toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
	toolCallId?: string;
	streaming?: boolean;
}

interface ViewState {
	messages: DisplayMessage[];
	isRunning: boolean;
	info: string[];
	error?: string;
}

const INITIAL: ViewState = { messages: [], isRunning: false, info: [] };

// ============================================================
// 事件 → state 归约
// ============================================================

function applyServerEvent(state: ViewState, ev: ServerEvent): ViewState {
	if (ev.kind === "info") return { ...state, info: [...state.info, ev.message] };
	if (ev.kind === "error") return { ...state, error: ev.message, isRunning: false };
	if (ev.kind === "compacted") {
		return { ...state, info: [...state.info, `Compacted. Active messages: ${ev.messagesAfter}`] };
	}

	const e = ev.event;
	switch (e.type) {
		case "agent_start":
			return { ...state, isRunning: true, error: undefined };
		case "message_start": {
			// 只为 assistant 流式显示开个占位
			return {
				...state,
				messages: [
					...state.messages,
					{ id: `streaming-${Date.now()}`, role: "assistant", content: "", streaming: true },
				],
			};
		}
		case "text_delta": {
			const msgs = [...state.messages];
			const last = msgs[msgs.length - 1];
			if (last?.streaming) {
				msgs[msgs.length - 1] = { ...last, content: last.content + e.text };
			} else {
				// 订阅起点在 message_start 之后（常见于刷新重连），
				// 此时还没有 streaming 占位 —— lazy 补一个，让 text_delta 事件自包含。
				msgs.push({
					id: `streaming-${Date.now()}`,
					role: "assistant",
					content: e.text,
					streaming: true,
				});
			}
			return { ...state, messages: msgs };
		}
		case "message_end": {
			const msgs = [...state.messages];
			const last = msgs[msgs.length - 1];
			const finalized: DisplayMessage = {
				id: `msg-${Date.now()}-${Math.random()}`,
				role: e.message.role === "system" ? "assistant" : (e.message.role as DisplayMessage["role"]),
				content: e.message.content,
				...(e.message.role === "assistant" && e.message.toolCalls ? { toolCalls: e.message.toolCalls } : {}),
				...(e.message.role === "tool" ? { toolCallId: e.message.toolCallId } : {}),
			};
			if (last?.streaming && e.message.role === "assistant") {
				msgs[msgs.length - 1] = finalized;
			} else if (
				// 乐观 user 消息去重：如果刚乐观插入的 user 和 message_end 的 user 内容一致，
				// 则替换本地占位而不是追加第二条。
				e.message.role === "user" &&
				last?.role === "user" &&
				last.content === e.message.content &&
				last.id.startsWith("local-")
			) {
				msgs[msgs.length - 1] = finalized;
			} else {
				msgs.push(finalized);
			}
			return { ...state, messages: msgs };
		}
		case "tool_start":
			return {
				...state,
				info: [...state.info, `→ tool: ${e.call.name}(${JSON.stringify(e.call.arguments).slice(0, 80)})`],
			};
		case "tool_end":
			return state; // tool 结果通过 message_end 进入 messages
		case "turn_start":
		case "turn_end":
			return state;
		case "agent_end": {
			const next = { ...state, isRunning: false };
			if (e.reason === "error") {
				return { ...next, error: e.error ?? "Agent stopped with an error" };
			}
			if (e.reason === "aborted") {
				return { ...next, info: [...next.info, "Agent aborted"] };
			}
			if (e.reason === "max_turns") {
				return { ...next, error: "Reached max turns without a final reply" };
			}
			return next;
		}
	}
}

// ============================================================
// 组件
// ============================================================

export function App() {
	const [sessions, setSessions] = useState<SessionSummary[]>([]);
	const [activeId, setActiveId] = useState<string | null>(null);
	const [view, setView] = useState<ViewState>(INITIAL);
	const [input, setInput] = useState("");
	const logRef = useRef<HTMLDivElement>(null);

	// 加载会话列表
	const refresh = useCallback(async () => {
		const { sessions: list } = await listSessions();
		setSessions(list);
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	// 打开一个 session
	const open = useCallback(async (id: string) => {
		setView(INITIAL);
		setActiveId(id);
		const resp = await openSession(id);
		const msgs: DisplayMessage[] = resp.messages
			.filter((m) => m.role !== "system")
			.map((m, i) => ({
				id: `restored-${i}`,
				role: m.role === "assistant" ? "assistant" : m.role === "tool" ? "tool" : "user",
				content: m.content,
				toolCalls: m.toolCalls,
				toolCallId: m.toolCallId,
			}));
		setView({ messages: msgs, isRunning: false, info: [] });
	}, []);

	// SSE 订阅
	useEffect(() => {
		if (!activeId) return;
		const un = subscribeEvents(activeId, (ev) => {
			setView((prev) => applyServerEvent(prev, ev));
		});
		return () => un();
	}, [activeId]);

	// 自动滚动到底部
	useEffect(() => {
		logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
	}, [view.messages.length]);

	// 新建会话
	const create = useCallback(async () => {
		const { sessionId } = await createSession();
		await refresh();
		await open(sessionId);
	}, [open, refresh]);

	// 发消息
	const submit = useCallback(
		async (e: React.FormEvent) => {
			e.preventDefault();
			if (!activeId || !input.trim()) return;
			const text = input;
			setInput("");
			// 乐观：立刻展示 user message（最终 message_end 事件会再补一次，但 reduce 已做去重）
			setView((prev) => ({
				...prev,
				error: undefined,
				messages: [
					...prev.messages,
					{ id: `local-${Date.now()}`, role: "user", content: text },
				],
				isRunning: true,
			}));
			await sendPrompt(activeId, text);
		},
		[activeId, input],
	);

	const onAbort = useCallback(() => {
		if (activeId) void abortRun(activeId);
	}, [activeId]);

	const infoSummary = useMemo(() => view.info.slice(-5), [view.info]);

	return (
		<div className="app">
			<aside className="sidebar">
				<div className="sidebar-header">
					<h1>mini-pi</h1>
					<button type="button" onClick={create}>
						New
					</button>
				</div>
				<ul className="session-list">
					{sessions.map((s) => (
						<li key={s.id}>
							<button
								type="button"
								className={activeId === s.id ? "active" : ""}
								onClick={() => open(s.id)}
								title={s.firstMessage}
							>
								<div className="sess-title">{s.firstMessage || "(empty)"}</div>
								<div className="sess-meta">
									{new Date(s.modified).toLocaleString()} · {s.messageCount} msgs
								</div>
							</button>
						</li>
					))}
				</ul>
			</aside>

			<main className="main">
				{!activeId ? (
					<div className="empty">Select or create a session.</div>
				) : (
					<>
						<div className="log" ref={logRef}>
							{view.messages.map((m) => (
								<MessageView key={m.id} message={m} />
							))}
							{view.isRunning && <div className="loading">agent is thinking…</div>}
							{view.error && <div className="error">{view.error}</div>}
						</div>
						<div className="info-bar">
							{infoSummary.map((line, i) => (
								<div key={`${i}-${line}`} className="info-line">
									{line}
								</div>
							))}
						</div>
						<form className="composer" onSubmit={submit}>
							<textarea
								value={input}
								placeholder="Type a message..."
								onChange={(e) => setInput(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter" && !e.shiftKey) {
										e.preventDefault();
										void submit(e);
									}
								}}
								disabled={view.isRunning}
							/>
							<div className="actions">
								{view.isRunning ? (
									<button type="button" onClick={onAbort}>
										Abort
									</button>
								) : (
									<button type="submit">Send</button>
								)}
							</div>
						</form>
					</>
				)}
			</main>
		</div>
	);
}

function MessageView({ message }: { message: DisplayMessage }) {
	return (
		<div className={`msg msg-${message.role}`}>
			<div className="msg-role">{message.role}</div>
			{message.content && <pre className="msg-content">{message.content}</pre>}
			{message.toolCalls?.map((tc) => (
				<div key={tc.id} className="tool-call">
					<div className="tool-call-name">→ {tc.name}</div>
					<pre className="tool-call-args">{JSON.stringify(tc.arguments, null, 2)}</pre>
				</div>
			))}
		</div>
	);
}
