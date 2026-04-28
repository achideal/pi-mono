/**
 * tools/write-file.ts — 写入/覆盖一个文本文件。
 *
 * 教学示例：带副作用的工具。
 * 会自动创建不存在的父目录。
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Tool } from "./types.js";

interface WriteFileArgs extends Record<string, unknown> {
	path: string;
	content: string;
}

export const writeFileTool: Tool<WriteFileArgs> = {
	schema: {
		name: "write_file",
		description: "Write (or overwrite) a text file. Creates parent directories as needed.",
		parameters: {
			path: { type: "string", description: "Absolute or relative path to the file." },
			content: { type: "string", description: "Full file contents to write." },
		},
		required: ["path", "content"],
	},
	async execute(args, signal) {
		if (signal?.aborted) return { output: "aborted", isError: true };
		try {
			const absolute = resolve(args.path);
			await mkdir(dirname(absolute), { recursive: true });
			await writeFile(absolute, args.content, "utf8");
			return { output: `Wrote ${args.content.length} bytes to ${absolute}` };
		} catch (err) {
			return { output: `Failed to write file: ${(err as Error).message}`, isError: true };
		}
	},
};
