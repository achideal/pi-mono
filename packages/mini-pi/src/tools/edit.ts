import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ToolExecutor } from "../core/types.js";

export interface EditParams {
	file_path: string;
	old_string: string;
	new_string: string;
	replace_all?: boolean;
}

export const editTool: ToolExecutor = {
	name: "edit",
	execute: async (params: unknown) => {
		const { file_path, old_string, new_string, replace_all = false } = params as EditParams;

		if (!file_path || typeof file_path !== "string") {
			throw new Error("file_path is required and must be a string");
		}

		if (old_string === undefined || old_string === null) {
			throw new Error("old_string is required");
		}

		if (new_string === undefined || new_string === null) {
			throw new Error("new_string is required");
		}

		const resolvedPath = resolve(process.cwd(), file_path);
		let content = await readFile(resolvedPath, "utf-8");

		if (replace_all) {
			const count = (content.match(new RegExp(old_string, "g")) || []).length;
			content = content.split(old_string).join(new_string);
			return `Replaced ${count} occurrences in ${file_path}`;
		} else {
			if (!content.includes(old_string)) {
				throw new Error(`old_string not found in ${file_path}`);
			}
			content = content.replace(old_string, new_string);
			return `Replaced 1 occurrence in ${file_path}`;
		}
	},
};
