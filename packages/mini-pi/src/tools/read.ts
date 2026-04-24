import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ToolExecutor } from "../core/types.js";

export interface ReadParams {
	file_path: string;
	offset?: number;
	limit?: number;
}

export const readTool: ToolExecutor = {
	name: "read",
	execute: async (params: unknown) => {
		const { file_path, offset = 0, limit } = params as ReadParams;

		if (!file_path || typeof file_path !== "string") {
			throw new Error("file_path is required and must be a string");
		}

		const resolvedPath = resolve(process.cwd(), file_path);
		let content = await readFile(resolvedPath, "utf-8");

		if (offset || limit) {
			const lines = content.split("\n");
			const start = offset || 0;
			const end = limit ? start + limit : lines.length;
			content = lines.slice(start, end).join("\n");
		}

		return content;
	},
};
