import { stream as streamAssistantMessage } from "../mini-pi-ai/stream.js";
import type { AssistantMessage, Message, Model, UserMessage } from "../mini-pi-ai/types.js";
import { createEmptyUsage } from "../mini-pi-ai/types.js";
import { runAgentLoop, runAgentLoopContinue } from "./agent-loop.js";
import type {
	AgentContext,
	AgentEvent,
	AgentListener,
	AgentLoopConfig,
	AgentOptions,
	AgentPromptInput,
	AgentState,
	AgentTool,
	StreamFn,
} from "./types.js";

const DEFAULT_MODEL: Model = {
	id: "unknown",
	name: "unknown",
	api: "openai-responses",
	provider: "openai-compatible",
	baseUrl: "",
	endpointUrl: "",
	reasoning: false,
	input: ["text"],
	maxTokens: 0,
};

type MutableAgentState = Omit<AgentState, "isStreaming" | "streamingMessage" | "pendingToolCalls" | "errorMessage"> & {
	isStreaming: boolean;
	streamingMessage?: AssistantMessage;
	pendingToolCalls: Set<string>;
	errorMessage?: string;
};

type ActiveRun = {
	promise: Promise<void>;
	resolve: () => void;
	abortController: AbortController;
};

function createMutableAgentState(
	initialState?: Partial<Omit<AgentState, "isStreaming" | "streamingMessage" | "pendingToolCalls" | "errorMessage">>,
): MutableAgentState {
	let tools = initialState?.tools?.slice() ?? [];
	let messages = initialState?.messages?.slice() ?? [];

	return {
		systemPrompt: initialState?.systemPrompt ?? "",
		model: initialState?.model ?? DEFAULT_MODEL,
		get tools() {
			return tools;
		},
		set tools(nextTools: AgentTool[]) {
			tools = nextTools.slice();
		},
		get messages() {
			return messages;
		},
		set messages(nextMessages: Message[]) {
			messages = nextMessages.slice();
		},
		isStreaming: false,
		streamingMessage: undefined,
		pendingToolCalls: new Set<string>(),
		errorMessage: undefined,
	};
}

function getModelApiKey(model: Model): string | undefined {
	if (!("apiKey" in model)) {
		return undefined;
	}
	const apiKey = model.apiKey;
	return typeof apiKey === "string" ? apiKey : undefined;
}

export class MiniAgent {
	private readonly listeners = new Set<AgentListener>();
	private readonly _state: MutableAgentState;
	private activeRun?: ActiveRun;

	public streamFn: StreamFn;
	public apiKey?: string;
	public headers?: Record<string, string>;
	public temperature?: number;
	public maxTokens?: number;
	public onPayload?: AgentLoopConfig["onPayload"];

	constructor(options: AgentOptions = {}) {
		this._state = createMutableAgentState(options.initialState);
		this.streamFn = options.streamFn ?? streamAssistantMessage;
		this.apiKey = options.apiKey;
		this.headers = options.headers;
		this.temperature = options.temperature;
		this.maxTokens = options.maxTokens;
		this.onPayload = options.onPayload;
	}

	subscribe(listener: AgentListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	get state(): AgentState {
		return this._state;
	}

	get signal(): AbortSignal | undefined {
		return this.activeRun?.abortController.signal;
	}

	abort(): void {
		this.activeRun?.abortController.abort();
	}

	waitForIdle(): Promise<void> {
		return this.activeRun?.promise ?? Promise.resolve();
	}

	reset(): void {
		this._state.messages = [];
		this._state.isStreaming = false;
		this._state.streamingMessage = undefined;
		this._state.pendingToolCalls = new Set<string>();
		this._state.errorMessage = undefined;
	}

	async prompt(input: AgentPromptInput): Promise<void> {
		if (this.activeRun) {
			throw new Error("Agent is already processing. Wait for completion before prompting again.");
		}

		const messages = this.normalizePromptInput(input);
		await this.runWithLifecycle(async (signal) => {
			await runLoopMessages(
				messages,
				this.createContextSnapshot(),
				this.createLoopConfig(),
				this.processEvent.bind(this),
				signal,
				this.streamFn,
			);
		});
	}

	async continue(): Promise<void> {
		if (this.activeRun) {
			throw new Error("Agent is already processing. Wait for completion before continuing.");
		}

		const lastMessage = this._state.messages[this._state.messages.length - 1];
		if (!lastMessage) {
			throw new Error("No messages to continue from");
		}

		if (lastMessage.role === "assistant") {
			throw new Error("Cannot continue from message role: assistant");
		}

		await this.runWithLifecycle(async (signal) => {
			await runContinuation(
				this.createContextSnapshot(),
				this.createLoopConfig(),
				this.processEvent.bind(this),
				signal,
				this.streamFn,
			);
		});
	}

	private normalizePromptInput(input: AgentPromptInput): UserMessage[] {
		if (Array.isArray(input)) {
			return input;
		}

		if (typeof input === "string") {
			return [{ role: "user", content: input, timestamp: Date.now() }];
		}

		return [input];
	}

	private createContextSnapshot(): AgentContext {
		return {
			systemPrompt: this._state.systemPrompt,
			messages: this._state.messages.slice(),
			tools: this._state.tools.slice(),
		};
	}

	private createLoopConfig(): AgentLoopConfig {
		return {
			model: this._state.model,
			apiKey: this.apiKey ?? getModelApiKey(this._state.model),
			headers: this.headers,
			temperature: this.temperature,
			maxTokens: this.maxTokens,
			onPayload: this.onPayload,
		};
	}

	private async runWithLifecycle(executor: (signal: AbortSignal) => Promise<void>): Promise<void> {
		const abortController = new AbortController();
		let resolveRun = () => {};
		const promise = new Promise<void>((resolve) => {
			resolveRun = resolve;
		});
		this.activeRun = { promise, resolve: resolveRun, abortController };

		this._state.isStreaming = true;
		this._state.streamingMessage = undefined;
		this._state.errorMessage = undefined;

		try {
			await executor(abortController.signal);
		} catch (error) {
			await this.handleRunFailure(error, abortController.signal.aborted);
		} finally {
			this.finishRun();
		}
	}

	private async handleRunFailure(error: unknown, aborted: boolean): Promise<void> {
		const failureMessage: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "" }],
			api: this._state.model.api,
			provider: this._state.model.provider,
			model: this._state.model.id,
			usage: createEmptyUsage(),
			stopReason: aborted ? "aborted" : "error",
			errorMessage: error instanceof Error ? error.message : String(error),
			timestamp: Date.now(),
		};

		this._state.messages.push(failureMessage);
		this._state.errorMessage = failureMessage.errorMessage;
		await this.processEvent({ type: "agent_end", messages: [failureMessage] });
	}

	private finishRun(): void {
		this._state.isStreaming = false;
		this._state.streamingMessage = undefined;
		this._state.pendingToolCalls = new Set<string>();
		this.activeRun?.resolve();
		this.activeRun = undefined;
	}

	private async processEvent(event: AgentEvent): Promise<void> {
		switch (event.type) {
			case "message_start":
				if (event.message.role === "assistant") {
					this._state.streamingMessage = event.message;
				}
				break;

			case "message_update":
				this._state.streamingMessage = event.message;
				break;

			case "message_end":
				if (event.message.role === "assistant") {
					this._state.streamingMessage = undefined;
				}
				this._state.messages.push(event.message);
				break;

			case "tool_execution_start": {
				const pendingToolCalls = new Set(this._state.pendingToolCalls);
				pendingToolCalls.add(event.toolCallId);
				this._state.pendingToolCalls = pendingToolCalls;
				break;
			}

			case "tool_execution_end": {
				const pendingToolCalls = new Set(this._state.pendingToolCalls);
				pendingToolCalls.delete(event.toolCallId);
				this._state.pendingToolCalls = pendingToolCalls;
				break;
			}

			case "turn_end":
				if (event.message.errorMessage) {
					this._state.errorMessage = event.message.errorMessage;
				}
				break;

			case "agent_end":
				this._state.streamingMessage = undefined;
				break;
		}

		const signal = this.activeRun?.abortController.signal;
		if (!signal) {
			throw new Error("Agent listener invoked outside active run");
		}

		for (const listener of this.listeners) {
			await listener(event, signal);
		}
	}
}

async function runLoopMessages(
	messages: Message[],
	context: AgentContext,
	config: AgentLoopConfig,
	emit: (event: AgentEvent) => Promise<void>,
	signal: AbortSignal,
	streamFn?: StreamFn,
): Promise<void> {
	await runAgentLoop(messages, context, config, emit, signal, streamFn);
}

async function runContinuation(
	context: AgentContext,
	config: AgentLoopConfig,
	emit: (event: AgentEvent) => Promise<void>,
	signal: AbortSignal,
	streamFn?: StreamFn,
): Promise<void> {
	await runAgentLoopContinue(context, config, emit, signal, streamFn);
}
