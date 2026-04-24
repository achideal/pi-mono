import type { Tool, ToolExecutor } from "../core/types.js";
import { bashTool } from "./bash.js";
import { editTool } from "./edit.js";
import { readTool } from "./read.js";
import { writeTool } from "./write.js";

export { type BashParams, bashTool } from "./bash.js";
export { type EditParams, editTool } from "./edit.js";
export { type ReadParams, readTool } from "./read.js";
export { type WriteParams, writeTool } from "./write.js";

export const builtinTools: ToolExecutor[] = [readTool, writeTool, bashTool, editTool];

export function getToolDefinitions(): Tool[] {
	return [
		{
			name: "read",
			description: "Read the contents of a file",
			inputSchema: {
				type: "object",
				properties: {
					file_path: {
						type: "string",
						description: "The path to the file to read",
					},
					offset: {
						type: "number",
						description: "The line number to start reading from",
					},
					limit: {
						type: "number",
						description: "The number of lines to read",
					},
				},
				required: ["file_path"],
			},
		},
		{
			name: "write",
			description: "Write content to a file",
			inputSchema: {
				type: "object",
				properties: {
					file_path: {
						type: "string",
						description: "The path to the file to write",
					},
					content: {
						type: "string",
						description: "The content to write to the file",
					},
				},
				required: ["file_path", "content"],
			},
		},
		{
			name: "bash",
			description: "Execute a shell command",
			inputSchema: {
				type: "object",
				properties: {
					command: {
						type: "string",
						description: "The command to execute",
					},
					timeout: {
						type: "number",
						description: "Timeout in milliseconds (default: 120000)",
					},
				},
				required: ["command"],
			},
		},
		{
			name: "edit",
			description: "Edit a file by replacing text",
			inputSchema: {
				type: "object",
				properties: {
					file_path: {
						type: "string",
						description: "The path to the file to edit",
					},
					old_string: {
						type: "string",
						description: "The text to replace",
					},
					new_string: {
						type: "string",
						description: "The new text",
					},
					replace_all: {
						type: "boolean",
						description: "Replace all occurrences",
					},
				},
				required: ["file_path", "old_string", "new_string"],
			},
		},
	];
}
