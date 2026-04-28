/**
 * tools 层公共导出。
 *
 * 包括：
 * - Tool / ToolResult 接口
 * - validateToolArguments 校验工具（供 agent-loop 使用）
 * - 三个内置工具：read_file / write_file / bash
 * - DEFAULT_TOOLS 便捷数组
 */

export { bashTool } from "./bash.js";
export { readFileTool } from "./read-file.js";
export type { Tool, ToolResult } from "./types.js";
export { type ValidationError, validateToolArguments } from "./validate.js";
export { writeFileTool } from "./write-file.js";

import { bashTool } from "./bash.js";
import { readFileTool } from "./read-file.js";
import type { Tool } from "./types.js";
import { writeFileTool } from "./write-file.js";

export const DEFAULT_TOOLS: Tool[] = [readFileTool as Tool, writeFileTool as Tool, bashTool as Tool];
