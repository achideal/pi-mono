import type { AgentTool } from "../src/index.js";
import { loadConfiguredModel, MiniAgent, Type } from "../src/index.js";
import { clearDebugLog, debug } from "./debug.js";

clearDebugLog();

const calculateParameters = Type.Object({
	operation: Type.Union([
		Type.Literal("add"),
		Type.Literal("subtract"),
		Type.Literal("multiply"),
		Type.Literal("divide"),
	]),
	left: Type.Number(),
	right: Type.Number(),
});

const calculateTool: AgentTool<typeof calculateParameters> = {
	name: "calculate",
	description: "Perform one basic arithmetic operation.",
	parameters: calculateParameters,
	async execute(_toolCallId, params, _signal, onUpdate) {
		onUpdate?.({
			content: [{ type: "text", text: "calculation started" }],
			details: { params },
		});

		const result = calculate(params.operation, params.left, params.right);
		return {
			content: [{ type: "text", text: String(result) }],
			details: { result },
		};
	},
};

const model = loadConfiguredModel("openai-responses");
const agent = new MiniAgent({
	initialState: {
		systemPrompt: [
			"You are a concise teaching assistant.",
			"When a calculation is needed, call the calculate tool before answering.",
		].join(" "),
		model,
		tools: [calculateTool],
	},
});

agent.subscribe((event) => {
	switch (event.type) {
		case "agent_start":
		case "agent_end":
		case "turn_start":
		case "turn_end":
			debug("agent event:", event.type, event);
			break;

		case "message_start":
		case "message_end":
			debug("message event:", event.type, event.message.role, event.message);
			break;

		case "message_update":
			debug("assistant stream:", event.assistantMessageEvent.type, event.assistantMessageEvent);
			break;

		case "tool_execution_start":
			debug("tool start:", event.toolName, event.args);
			break;

		case "tool_execution_update":
			debug("tool update:", event.toolName, event.partialResult);
			break;

		case "tool_execution_end":
			debug("tool end:", event.toolName, {
				isError: event.isError,
				result: event.result,
			});
			break;
	}
});

await agent.prompt("Use the calculate tool to compute 17 * 23, then answer in one short sentence.");

debug("final messages:", agent.state.messages);
debug("isStreaming:", agent.state.isStreaming);
debug("pendingToolCalls:", Array.from(agent.state.pendingToolCalls));

function calculate(operation: "add" | "subtract" | "multiply" | "divide", left: number, right: number): number {
	switch (operation) {
		case "add":
			return left + right;
		case "subtract":
			return left - right;
		case "multiply":
			return left * right;
		case "divide":
			if (right === 0) {
				throw new Error("Cannot divide by zero.");
			}
			return left / right;
	}
}
