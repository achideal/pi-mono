/**
 * tools/validate.ts — 工具参数的极简校验。
 *
 * 【教学要点】
 * - 校验是 agent-loop（内核）的职责之一，但校验的**规则**在这里定义。
 * - 我们不引入 zod / typebox / ajv —— 只做类型标签匹配 + 必填检查。
 *   够教学用，也让读者看清"JSON Schema 校验的内核不过是字段遍历"。
 */

import type { ToolSchema } from "../ai/index.js";

export interface ValidationError {
	message: string;
}

/**
 * 校验 LLM 给出的参数是否满足工具 schema。
 * 成功时返回 `null`，失败时返回错误信息（给 LLM 作为 tool_result 输出）。
 */
export function validateToolArguments(schema: ToolSchema, args: Record<string, unknown>): ValidationError | null {
	for (const key of schema.required) {
		if (!(key in args)) {
			return { message: `Missing required parameter: ${key}` };
		}
	}

	for (const [key, spec] of Object.entries(schema.parameters)) {
		if (!(key in args)) continue; // 非必填可以不提供
		const value = args[key];
		const actual = typeof value;
		if (spec.type === "string" && actual !== "string") {
			return { message: `Parameter ${key} must be string, got ${actual}` };
		}
		if (spec.type === "number" && actual !== "number") {
			return { message: `Parameter ${key} must be number, got ${actual}` };
		}
		if (spec.type === "boolean" && actual !== "boolean") {
			return { message: `Parameter ${key} must be boolean, got ${actual}` };
		}
	}

	return null;
}
