import type { Static, TSchema } from "@sinclair/typebox";
import { type TypeCheck, TypeCompiler } from "@sinclair/typebox/compiler";
import { Value } from "@sinclair/typebox/value";
import type { Tool, ToolCall } from "../mini-pi-ai/types.js";

const compiledSchemas = new WeakMap<TSchema, TypeCheck<TSchema>>();

function getTypeCheck<TSchemaType extends TSchema>(schema: TSchemaType): TypeCheck<TSchemaType> {
	const cached = compiledSchemas.get(schema);
	if (cached) {
		return cached as TypeCheck<TSchemaType>;
	}

	const compiled = TypeCompiler.Compile(schema);
	compiledSchemas.set(schema, compiled);
	return compiled;
}

export function validateToolArguments<TParameters extends TSchema>(
	tool: Tool<TParameters>,
	toolCall: ToolCall,
): Static<TParameters> {
	const args = structuredClone(toolCall.arguments);
	const converted = Value.Convert(tool.parameters, args);
	const checker = getTypeCheck(tool.parameters);

	if (checker.Check(converted)) {
		return converted;
	}

	const errors = Array.from(checker.Errors(converted))
		.map((error) => {
			const path = error.path.replace(/^\//u, "") || "root";
			return `  - ${path}: ${error.message}`;
		})
		.join("\n");

	const errorMessage = [
		`Validation failed for tool "${toolCall.name}".`,
		errors || "  - root: unknown validation error",
		"Received arguments:",
		JSON.stringify(toolCall.arguments, null, 2),
	].join("\n");

	throw new Error(errorMessage);
}
