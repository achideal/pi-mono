import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ToolExecutor } from "../core/types.js";

export interface WriteParams {
	file_path: string;
	content: string;
}

export const writeTool: ToolExecutor = {
	name: "write",
	execute: async (params: unknown) => {
		const { file_path, content } = params as WriteParams;

		if (!file_path || typeof file_path !== "string") {
			throw new Error("file_path is required and must be a string");
		}

		if (content === undefined || content === null) {
			throw new Error("content is required");
		}

		const resolvedPath = resolve(process.cwd(), file_path);
		await writeFile(resolvedPath, content, "utf-8");

		return `Successfully wrote to ${file_path}`;
	},
};
