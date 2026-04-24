import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SessionEntry } from "../core/types.js";

const SESSION_DIR = ".mini-pi/sessions";

export class FileSessionStore {
	private basePath: string;

	constructor(basePath = process.cwd()) {
		this.basePath = basePath;
	}

	async load(sessionId: string): Promise<SessionEntry[] | null> {
		try {
			const filePath = this.getSessionPath(sessionId);
			const content = await readFile(filePath, "utf-8");
			return JSON.parse(content) as SessionEntry[];
		} catch {
			return null;
		}
	}

	async save(sessionId: string, entries: SessionEntry[]): Promise<void> {
		await mkdir(join(this.basePath, SESSION_DIR), { recursive: true });
		const filePath = this.getSessionPath(sessionId);
		await writeFile(filePath, JSON.stringify(entries, null, 2), "utf-8");
	}

	async listSessions(): Promise<Array<{ id: string; timestamp: string }>> {
		try {
			const dir = join(this.basePath, SESSION_DIR);
			const { readdir } = await import("node:fs/promises");
			const files = await readdir(dir, { withFileTypes: true });

			const sessions: Array<{ id: string; timestamp: string }> = [];
			for (const file of files) {
				if (file.isFile() && file.name.endsWith(".json")) {
					const sessionId = file.name.slice(0, -5);
					const content = await readFile(join(dir, file.name), "utf-8");
					const entries = JSON.parse(content) as SessionEntry[];
					const lastEntry = entries[entries.length - 1];
					sessions.push({
						id: sessionId,
						timestamp: lastEntry?.timestamp || "",
					});
				}
			}

			return sessions.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
		} catch {
			return [];
		}
	}

	async deleteSession(sessionId: string): Promise<void> {
		try {
			const filePath = this.getSessionPath(sessionId);
			const { unlink } = await import("node:fs/promises");
			await unlink(filePath);
		} catch {
			// Ignore errors
		}
	}

	generateSessionId(): string {
		return randomUUID();
	}

	private getSessionPath(sessionId: string): string {
		return join(this.basePath, SESSION_DIR, `${sessionId}.json`);
	}
}
