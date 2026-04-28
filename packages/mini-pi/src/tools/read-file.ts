/**
 * tools/read-file.ts — 读取一个文本文件。
 *
 * 教学示例：最简单的"只读工具"。
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Tool } from "./types.js";

interface ReadFileArgs extends Record<string, unknown> {
	path: string;
}

export const readFileTool: Tool<ReadFileArgs> = {
	schema: {
		name: "read_file",
		description: "Read a text file from the local filesystem.",
		parameters: {
			path: { type: "string", description: "Absolute or relative path to the file." },
		},
		required: ["path"],
	},
	async execute(args, signal) {
		if (signal?.aborted) return { output: "aborted", isError: true };
		try {
			const absolute = resolve(args.path);
			const content = await readFile(absolute, "utf8");
			return { output: content };
		} catch (err) {
			return { output: `Failed to read file: ${(err as Error).message}`, isError: true };
		}
	},
};
