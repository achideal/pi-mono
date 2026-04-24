import type { AIClient } from "../ai/index.js";
import { createToolResultMessage } from "../ai/index.js";
import { EventEmitter } from "./events.js";
import { HookManager } from "./hooks.js";
import type { Hooks, Message, SessionManager, ToolExecutor } from "./types.js";

interface AgentLoopConfig {
	aiClient: AIClient;
	session: SessionManager;
	tools: ToolExecutor[];
	hooks?: Hooks;
}

export class AgentLoop {
	private aiClient: AIClient;
	private session: SessionManager;
	private tools: Map<string, ToolExecutor>;
	private eventEmitter: EventEmitter;
	private hookManager: HookManager;
	private running = false;

	constructor(config: AgentLoopConfig) {
		this.aiClient = config.aiClient;
		this.session = config.session;
		this.eventEmitter = new EventEmitter();
		this.hookManager = new HookManager();

		// Register tools
		this.tools = new Map();
		for (const tool of config.tools) {
			this.tools.set(tool.name, tool);
		}

		// Register hooks
		if (config.hooks) {
			this.hookManager.register(config.hooks);
		}
	}

	on(eventType: string, listener: (event: unknown) => void | Promise<void>): void {
		this.eventEmitter.on(eventType as any, listener);
	}

	async run(userMessage: string): Promise<void> {
		this.running = true;

		// Add user message to session
		this.session.append({
			type: "message",
			parentId: this.session.getCurrentLeaf(),
			data: { role: "user", content: userMessage },
		});

		await this.eventEmitter.emit({ type: "agent_start" });

		while (this.running) {
			await this.eventEmitter.emit({ type: "turn_start" });

			// Get current context
			const messages = this.session.getBranch();
			const toolDefinitions = Array.from(this.tools.values()).map((t) => ({
				name: t.name,
				description: "",
				inputSchema: {},
			}));

			await this.eventEmitter.emit({ type: "message_start" });

			// Stream AI response
			let assistantContent = "";
			const toolCalls: Array<{ id: string; name: string; arguments: string }> = [];

			for await (const event of this.aiClient.stream(messages, toolDefinitions)) {
				if (event.type === "text_delta") {
					const data = event.data as { delta: string };
					assistantContent += data.delta;
					await this.eventEmitter.emit({ type: "text_delta", data });
				} else if (event.type === "toolcall_end") {
					const data = event.data as { id: string; name: string; arguments: string };
					toolCalls.push({ id: data.id, name: data.name, arguments: data.arguments });
					await this.eventEmitter.emit({
						type: "toolcall_start",
						data: { name: data.name, args: data.arguments },
					});
				} else if (event.type === "done") {
					break;
				}
			}

			// Create assistant message
			const assistantMessage: Message = {
				role: "assistant",
				content: assistantContent,
				toolCalls:
					toolCalls.length > 0
						? toolCalls.map((tc) => ({
								id: tc.id,
								name: tc.name,
								arguments: tc.arguments,
							}))
						: undefined,
			};

			this.session.append({
				type: "message",
				parentId: this.session.getCurrentLeaf(),
				data: assistantMessage,
			});

			// If no tool calls, we're done
			if (toolCalls.length === 0) {
				await this.eventEmitter.emit({ type: "turn_end" });
				break;
			}

			// Execute tool calls
			for (const tc of toolCalls) {
				const tool = this.tools.get(tc.name);
				if (!tool) {
					const error = `Tool ${tc.name} not found`;
					await this.eventEmitter.emit({
						type: "toolcall_end",
						data: { name: tc.name, result: error, isError: true },
					});
					this.session.append({
						type: "message",
						parentId: this.session.getCurrentLeaf(),
						data: createToolResultMessage(tc.id, error, true),
					});
					continue;
				}

				try {
					let args: unknown = tc.arguments;
					try {
						args = JSON.parse(tc.arguments);
					} catch {
						// Arguments already parsed or not JSON
					}

					await this.hookManager.executeBeforeToolCall({ toolName: tc.name, toolArgs: args });

					const result = await tool.execute(args);

					await this.hookManager.executeAfterToolCall({ toolName: tc.name, toolResult: result });

					await this.eventEmitter.emit({ type: "toolcall_end", data: { name: tc.name, result } });

					this.session.append({
						type: "message",
						parentId: this.session.getCurrentLeaf(),
						data: createToolResultMessage(tc.id, result),
					});
				} catch (error) {
					const errorMessage = error instanceof Error ? error.message : String(error);
					await this.eventEmitter.emit({
						type: "toolcall_end",
						data: { name: tc.name, result: errorMessage, isError: true },
					});
					this.session.append({
						type: "message",
						parentId: this.session.getCurrentLeaf(),
						data: createToolResultMessage(tc.id, errorMessage, true),
					});
				}
			}

			await this.eventEmitter.emit({ type: "turn_end" });
		}
	}

	stop(): void {
		this.running = false;
	}
}
