/**
 * tools/bash.ts — 执行一个 shell 命令，带超时。
 *
 * 教学要点：
 * - 展示"工具要如何正确响应 AbortSignal"（spawn 的 child 需要 kill）
 * - 刻意不做 interactive / pty；只捕获 stdout+stderr
 * - 默认 30 秒超时，足够一般命令，避免教学环境 hang 住
 */

import { spawn } from "node:child_process";
import type { Tool } from "./types.js";

interface BashArgs extends Record<string, unknown> {
	command: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 100_000;

export const bashTool: Tool<BashArgs> = {
	schema: {
		name: "bash",
		description: `Execute a shell command. Output is truncated to ${MAX_OUTPUT_BYTES} bytes and the process is killed after ${DEFAULT_TIMEOUT_MS / 1000}s.`,
		parameters: {
			command: { type: "string", description: "Shell command (evaluated via /bin/sh -c)." },
		},
		required: ["command"],
	},
	async execute(args, signal) {
		if (signal?.aborted) return { output: "aborted", isError: true };

		return new Promise((resolvePromise) => {
			const child = spawn("/bin/sh", ["-c", args.command], { stdio: ["ignore", "pipe", "pipe"] });
			let stdout = "";
			let stderr = "";
			let truncated = false;

			const append = (kind: "out" | "err", chunk: Buffer): void => {
				const s = chunk.toString("utf8");
				if (kind === "out") {
					if (stdout.length + s.length > MAX_OUTPUT_BYTES) {
						stdout += s.slice(0, MAX_OUTPUT_BYTES - stdout.length);
						truncated = true;
					} else {
						stdout += s;
					}
				} else {
					if (stderr.length + s.length > MAX_OUTPUT_BYTES) {
						stderr += s.slice(0, MAX_OUTPUT_BYTES - stderr.length);
						truncated = true;
					} else {
						stderr += s;
					}
				}
			};

			child.stdout.on("data", (c: Buffer) => append("out", c));
			child.stderr.on("data", (c: Buffer) => append("err", c));

			const timer = setTimeout(() => {
				child.kill("SIGTERM");
			}, DEFAULT_TIMEOUT_MS);

			const onAbort = (): void => {
				child.kill("SIGTERM");
			};
			signal?.addEventListener("abort", onAbort, { once: true });

			child.on("close", (code) => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);

				const parts: string[] = [];
				if (stdout) parts.push(`[stdout]\n${stdout}`);
				if (stderr) parts.push(`[stderr]\n${stderr}`);
				parts.push(`[exit] code=${code ?? "null"}`);
				if (truncated) parts.push(`[note] output truncated at ${MAX_OUTPUT_BYTES} bytes`);

				resolvePromise({
					output: parts.join("\n\n"),
					isError: code !== 0,
				});
			});

			child.on("error", (err) => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				resolvePromise({ output: `Failed to spawn: ${err.message}`, isError: true });
			});
		});
	},
};
