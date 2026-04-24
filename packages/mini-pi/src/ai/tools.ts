import type { Tool } from "../core/types.js";
import type { FunctionDefinition } from "./types.js";

export function toOpenAITool(tool: Tool): { type: "function"; function: FunctionDefinition } {
	return {
		type: "function",
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.inputSchema,
		},
	};
}

export function toOpenAITools(tools: Tool[]): { type: "function"; function: FunctionDefinition }[] {
	return tools.map(toOpenAITool);
}
