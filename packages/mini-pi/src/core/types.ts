// Message types
export type Role = "user" | "assistant" | "tool";

export interface Message {
	role: Role;
	content: string;
	toolCalls?: ToolCall[];
	toolResult?: ToolResult;
	id?: string;
}

export interface ToolCall {
	id: string;
	name: string;
	arguments: string;
}

export interface ToolResult {
	toolCallId: string;
	content: string;
	isError?: boolean;
}

// Tool definition
export interface Tool {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
}

export interface ToolExecutor {
	name: string;
	execute: (params: unknown) => Promise<string>;
}

// Session types
export type SessionEntryType = "message" | "compaction" | "branch_start" | "branch_end";

export interface SessionEntry {
	id: string;
	type: SessionEntryType;
	parentId: string | null;
	timestamp: string;
	data: Message | CompactionData | BranchData;
}

export interface CompactionData {
	summary: string;
	entryCount: number;
}

export interface BranchData {
	fromId: string;
	branchId: string;
}

// Event types
export type AgentEventType =
	| "agent_start"
	| "turn_start"
	| "message_start"
	| "text_delta"
	| "toolcall_start"
	| "toolcall_end"
	| "turn_end"
	| "compaction";

export interface AgentEvent {
	type: AgentEventType;
	data?: unknown;
}

export interface TextDeltaEvent extends AgentEvent {
	type: "text_delta";
	data: { delta: string };
}

export interface ToolCallStartEvent extends AgentEvent {
	type: "toolcall_start";
	data: { name: string; args: string };
}

export interface ToolCallEndEvent extends AgentEvent {
	type: "toolcall_end";
	data: { name: string; result: string; isError?: boolean };
}

export interface CompactionEvent extends AgentEvent {
	type: "compaction";
	data: { summary: string; entryCount: number };
}

// Hook types
export interface HookContext {
	toolName?: string;
	toolArgs?: unknown;
	toolResult?: string;
	session?: SessionManager;
}

export type HookFn<T = void> = (context: HookContext) => T | Promise<T>;

export interface Hooks {
	beforeToolCall?: HookFn;
	afterToolCall?: HookFn;
	onCompact?: HookFn;
	onTurnStart?: HookFn;
	onTurnEnd?: HookFn;
}

// Session manager interface
export interface SessionManager {
	append(entry: Omit<SessionEntry, "id" | "timestamp">): string;
	branch(fromId: string): string;
	getBranch(leafId?: string): Message[];
	getTree(): TreeNode[];
	getCurrentLeaf(): string | null;
	setLeaf(id: string): void;
	export(): SessionEntry[];
	import(entries: SessionEntry[]): void;
}

export interface TreeNode {
	id: string;
	type: string;
	parentId: string | null;
	children: TreeNode[];
	timestamp: string;
}
