/**
 * session/fs-backend.ts — 文件系统后端（JSONL，append-only）。
 *
 * 目录布局：
 *   {rootDir}/{encodedCwd}/{timestamp}_{id}.jsonl
 *
 * 每行一条 JSON 记录，第一行必须是 SessionHeader。
 *
 * 教学要点：
 * - append-only 意味着**故障安全** —— 即使进程崩溃，已写入的行永远有效
 * - 用 JSONL 而不是 SQLite：没有 schema migration 负担，人类可读
 */

import { createReadStream } from "node:fs";
import { appendFile, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import type { SessionBackend, SessionEntry, SessionFileRecord, SessionHeader, SessionSummary } from "./types.js";

function encodeCwd(cwd: string): string {
	return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

async function readJsonl(path: string): Promise<SessionFileRecord[]> {
	const records: SessionFileRecord[] = [];
	const rl = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
	for await (const line of rl) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			records.push(JSON.parse(trimmed) as SessionFileRecord);
		} catch {
			// 跳过损坏行
		}
	}
	return records;
}

export interface FsSessionBackendOptions {
	/** 根目录，默认 ~/.mini-pi/sessions */
	rootDir?: string;
}

export class FsSessionBackend implements SessionBackend {
	private readonly rootDir: string;
	/** sessionId → 绝对文件路径 的缓存（同一进程内持久） */
	private readonly pathCache = new Map<string, string>();

	constructor(options: FsSessionBackendOptions = {}) {
		this.rootDir = options.rootDir ?? join(homedir(), ".mini-pi", "sessions");
	}

	private async resolvePath(id: string, cwd?: string, timestamp?: string): Promise<string> {
		const cached = this.pathCache.get(id);
		if (cached) return cached;

		// 如果提供了 cwd + timestamp，说明是新建；直接构造
		if (cwd && timestamp) {
			const dir = join(this.rootDir, encodeCwd(cwd));
			await mkdir(dir, { recursive: true });
			const path = join(dir, `${timestamp.replace(/[:.]/g, "-")}_${id}.jsonl`);
			this.pathCache.set(id, path);
			return path;
		}

		// 否则扫描 rootDir 找 id 匹配的文件
		const found = await this.findById(id);
		if (!found) throw new Error(`Session ${id} not found`);
		this.pathCache.set(id, found);
		return found;
	}

	private async findById(id: string): Promise<string | null> {
		try {
			const projects = await readdir(this.rootDir);
			for (const proj of projects) {
				const dir = join(this.rootDir, proj);
				let files: string[];
				try {
					files = await readdir(dir);
				} catch {
					continue;
				}
				for (const f of files) {
					if (f.endsWith(`_${id}.jsonl`)) {
						return join(dir, f);
					}
				}
			}
		} catch {
			return null;
		}
		return null;
	}

	async load(id: string): Promise<SessionFileRecord[] | null> {
		const path = await this.findById(id);
		if (!path) return null;
		this.pathCache.set(id, path);
		return readJsonl(path);
	}

	async writeHeader(id: string, header: SessionHeader): Promise<void> {
		const path = await this.resolvePath(id, header.cwd, header.timestamp);
		await writeFile(path, `${JSON.stringify(header)}\n`, "utf8");
	}

	async appendEntry(id: string, entry: SessionEntry): Promise<void> {
		const path = await this.resolvePath(id);
		await appendFile(path, `${JSON.stringify(entry)}\n`, "utf8");
	}

	async list(cwd: string): Promise<SessionSummary[]> {
		const dir = join(this.rootDir, encodeCwd(cwd));
		let files: string[];
		try {
			files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl"));
		} catch {
			return [];
		}

		const out: SessionSummary[] = [];
		for (const f of files) {
			const path = join(dir, f);
			try {
				const records = await readJsonl(path);
				const header = records.find((r) => r.type === "session");
				if (!header) continue;
				const s = await stat(path);
				const msgs = records.filter((r): r is SessionEntry & { type: "message" } => r.type === "message");
				const first = msgs.find((m) => m.message.role === "user");
				out.push({
					id: header.id,
					cwd: header.cwd,
					modified: s.mtime,
					firstMessage: first?.message.role === "user" ? first.message.content.slice(0, 200) : "",
					messageCount: msgs.length,
				});
				this.pathCache.set(header.id, path);
			} catch {
				// 损坏文件，跳过
				void basename(f);
			}
		}
		return out.sort((a, b) => b.modified.getTime() - a.modified.getTime());
	}
}
