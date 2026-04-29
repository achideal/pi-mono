/**
 * web/server.ts — mini-pi 的 Composition Root。
 *
 * 【教学要点】
 * 整个项目**所有** `new` 和依赖装配都发生在这个文件。要查任何能力从哪来，看这里。
 *
 * 本文件职责：
 *  1. 读环境变量（MINI_PI_API_KEY / MINI_PI_ BASE_URL / 模型 / provider）
 *  2. 装配 Agent + SessionStore + Compactor
 *  3. 开 HTTP server：
 *     - GET  /              静态首页 HTML
 *     - GET  /client.js     打包好的前端
 *     - GET  /api/sessions  列出会话
 *     - POST /api/sessions  新建会话
 *     - GET  /api/sessions/:id  打开会话（返回 messages）
 *     - GET  /api/events?sessionId=xxx  SSE 订阅
 *     - POST /api/prompt    发起 prompt
 *     - POST /api/abort     中止当前运行
 *  4. 编排压缩：每次 agent_end 后检查是否需要压缩，需要则执行
 */

import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Agent, type AgentEvent } from "../agent/index.js";
import { type ProviderKind, pickProvider } from "../ai/index.js";
import { compact, DEFAULT_COMPACTION_POLICY, FsSessionBackend, SessionStore } from "../session/index.js";
import { DEFAULT_TOOLS } from "../tools/index.js";
import type {
	CreateSessionResponse,
	ListSessionsResponse,
	OpenSessionResponse,
	PromptRequest,
	ServerEvent,
} from "./api.js";
import { EventHub } from "./event-hub.js";

// ============================================================
// 配置
// ============================================================

const PORT = Number(process.env.MINI_PI_PORT ?? 5173);
const API_KEY = process.env.MINI_PI_API_KEY ?? "";
const BASE_URL = process.env.MINI_PI_BASE_URL;
const MODEL = process.env.MINI_PI_MODEL ?? "gpt-4o-mini";
const PROVIDER_KIND = (process.env.MINI_PI_PROVIDER ?? "chat-completions") as ProviderKind;

const SYSTEM_PROMPT = `You are mini-pi, a minimal coding agent. You have access to three tools:
- read_file: read a local file
- write_file: write (or overwrite) a local file
- bash: execute a shell command

Tool-use policy:
- Only call a tool when the user's request truly requires accessing the local filesystem or running a command.
- For conversational messages (greetings, chit-chat, general questions, explanations), reply with plain text and DO NOT call any tool.
- Prefer the smallest necessary action; never invoke bash just to print or echo text.

Keep replies concise.`;

if (!API_KEY) {
	console.error("Set MINI_PI_API_KEY before starting mini-pi.");
	process.exit(1);
}

// ============================================================
// 装配层：每个 session 对应一个 Agent + Store
// ============================================================

interface SessionRuntime {
	agent: Agent;
	store: SessionStore;
	unsubAgent: () => void; // agent → store 落盘订阅
	unsubBridge: () => void; // agent → SSE 广播
}

const backend = new FsSessionBackend();
const streamFn = pickProvider(PROVIDER_KIND);
const hub = new EventHub();
const runtimes = new Map<string, SessionRuntime>();

async function getOrCreateRuntime(sessionId: string): Promise<SessionRuntime> {
	const existing = runtimes.get(sessionId);
	if (existing) return existing;

	const store = await SessionStore.open(sessionId, backend);

	const agent = new Agent({
		systemPrompt: SYSTEM_PROMPT,
		tools: DEFAULT_TOOLS,
		model: MODEL,
		apiKey: API_KEY,
		baseUrl: BASE_URL,
		streamFn,
		initialMessages: [...store.buildMessages()],
	});

	const unsubAgent = store.attachTo(agent);

	// Bridge：Agent 事件 → SSE 广播
	const unsubBridge = agent.subscribe(async (event: AgentEvent) => {
		hub.publish(sessionId, { kind: "agent", event });

		// 服务端可观测性：出错时在终端打印
		if (event.type === "agent_end" && event.reason === "error") {
			console.error(`[session ${sessionId.slice(0, 8)}] agent_end error: ${event.error ?? "(no message)"}`);
		}

		// 压缩编排：agent_end 后检查
		if (event.type === "agent_end" && event.reason === "stop") {
			await maybeCompact(sessionId, agent, store);
		}
	});

	const runtime: SessionRuntime = { agent, store, unsubAgent, unsubBridge };
	runtimes.set(sessionId, runtime);
	return runtime;
}

async function maybeCompact(sessionId: string, agent: Agent, store: SessionStore): Promise<void> {
	if (agent.isRunning()) return; // 保险：不在活跃运行时期间
	const tokens = store.estimatedTokens();
	if (!DEFAULT_COMPACTION_POLICY.shouldCompact(store.getEntries(), tokens)) return;

	hub.publish(sessionId, { kind: "info", message: "Compacting conversation..." });
	try {
		const result = await compact({
			entries: store.getEntries(),
			policy: DEFAULT_COMPACTION_POLICY,
			streamFn,
			apiKey: API_KEY,
			model: MODEL,
			baseUrl: BASE_URL,
		});
		if (!result) return;
		await store.appendCompaction(result.summary, result.firstKeptEntryId, result.tokensBefore);
		agent.replaceTranscript(store.buildMessages());
		hub.publish(sessionId, { kind: "compacted", messagesAfter: store.buildMessages().length });
	} catch (err) {
		hub.publish(sessionId, { kind: "error", message: `Compaction failed: ${(err as Error).message}` });
	}
}

// ============================================================
// HTTP
// ============================================================

const DIST_DIR = dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = resolve(DIST_DIR, "client");

async function serveStatic(filePath: string, contentType: string, res: ServerResponse): Promise<void> {
	try {
		const content = await readFile(filePath);
		res.writeHead(200, { "Content-Type": contentType });
		res.end(content);
	} catch {
		res.writeHead(404);
		res.end("Not found");
	}
}

async function readBody(req: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) {
		chunks.push(chunk as Buffer);
	}
	return Buffer.concat(chunks).toString("utf8");
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { "Content-Type": "application/json" });
	res.end(JSON.stringify(body));
}

const server = createServer(async (req, res) => {
	const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
	const method = req.method ?? "GET";

	try {
		// ---------- 静态资源 ----------
		if (method === "GET" && url.pathname === "/") {
			return serveStatic(join(CLIENT_DIR, "index.html"), "text/html; charset=utf-8", res);
		}
		if (method === "GET" && url.pathname === "/client.js") {
			return serveStatic(join(CLIENT_DIR, "client.js"), "application/javascript; charset=utf-8", res);
		}

		// ---------- 列会话 ----------
		if (method === "GET" && url.pathname === "/api/sessions") {
			const sessions = await backend.list(process.cwd());
			return sendJson(res, 200, { sessions } satisfies ListSessionsResponse);
		}

		// ---------- 新建会话 ----------
		if (method === "POST" && url.pathname === "/api/sessions") {
			const store = await SessionStore.create(process.cwd(), backend);
			return sendJson(res, 200, { sessionId: store.getId() } satisfies CreateSessionResponse);
		}

		// ---------- 打开会话（返回 messages） ----------
		const openMatch = /^\/api\/sessions\/([^/]+)$/.exec(url.pathname);
		if (method === "GET" && openMatch) {
			const sessionId = openMatch[1];
			const runtime = await getOrCreateRuntime(sessionId);
			const msgs = runtime.store.buildMessages().map((m) => ({
				role: m.role,
				content: m.content,
				...(m.role === "assistant" && m.toolCalls ? { toolCalls: m.toolCalls } : {}),
				...(m.role === "tool" ? { toolCallId: m.toolCallId } : {}),
			}));
			return sendJson(res, 200, { sessionId, messages: msgs } satisfies OpenSessionResponse);
		}

		// ---------- SSE 订阅 ----------
		if (method === "GET" && url.pathname === "/api/events") {
			const sessionId = url.searchParams.get("sessionId");
			if (!sessionId) {
				res.writeHead(400);
				res.end("Missing sessionId");
				return;
			}
			res.writeHead(200, {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
			});
			// 确保 runtime 已初始化
			await getOrCreateRuntime(sessionId);
			hub.subscribe(sessionId, res);
			return;
		}

		// ---------- 发 prompt ----------
		if (method === "POST" && url.pathname === "/api/prompt") {
			const body = JSON.parse(await readBody(req)) as PromptRequest;
			const runtime = await getOrCreateRuntime(body.sessionId);
			if (runtime.agent.isRunning()) {
				return sendJson(res, 409, { error: "Agent is busy" });
			}
			// 异步跑，不阻塞响应
			void runtime.agent.prompt(body.text).catch((err) => {
				hub.publish(body.sessionId, { kind: "error", message: String(err) });
			});
			return sendJson(res, 200, { ok: true });
		}

		// ---------- abort ----------
		if (method === "POST" && url.pathname === "/api/abort") {
			const body = JSON.parse(await readBody(req)) as { sessionId: string };
			const runtime = runtimes.get(body.sessionId);
			runtime?.agent.abort();
			return sendJson(res, 200, { ok: true });
		}

		res.writeHead(404);
		res.end("Not found");
	} catch (err) {
		console.error("[server]", err);
		sendJson(res, 500, { error: (err as Error).message });
	}
});

server.listen(PORT, () => {
	console.log(`mini-pi listening on http://localhost:${PORT}`);
	console.log(`  provider: ${PROVIDER_KIND}`);
	console.log(`  model:    ${MODEL}`);
	console.log(`  baseUrl:  ${BASE_URL ?? "(default: https://api.openai.com/v1)"}`);
	console.log(`  sessions: ~/.mini-pi/sessions/`);
});

function _referenceUnused(e: ServerEvent): void {
	// Keep ServerEvent type referenced to ensure it stays in sync.
	void e;
}
void _referenceUnused;
