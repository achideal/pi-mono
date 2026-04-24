import type { SessionManager } from "../core/types.js";

export interface CommandContext {
	session: SessionManager;
	args: string[];
}

export type CommandHandler = (context: CommandContext) => string | Promise<string>;

export const commands: Record<string, CommandHandler> = {
	branch: async ({ session, args }) => {
		if (args.length === 0) {
			const entries = session.export();
			const branches = entries.filter((e) => e.parentId === null);
			return `Available branches:\n${branches.map((b) => `  ${b.id.slice(0, 8)}`).join("\n")}`;
		}
		try {
			const branchId = session.branch(args[0]);
			return `Created branch: ${branchId}`;
		} catch (error) {
			throw new Error(`Failed to create branch: ${error instanceof Error ? error.message : String(error)}`);
		}
	},

	switch: ({ session, args }) => {
		if (args.length === 0) {
			throw new Error("Usage: :switch <branch-id>");
		}
		try {
			session.setLeaf(args[0]);
			return `Switched to branch: ${args[0]}`;
		} catch (error) {
			throw new Error(`Failed to switch branch: ${error instanceof Error ? error.message : String(error)}`);
		}
	},

	tree: ({ session }) => {
		const tree = session.getTree();
		return formatTree(tree);
	},

	export: ({ session, args }) => {
		const entries = session.export();
		const json = JSON.stringify(entries, null, 2);
		if (args.length > 0) {
			const { writeFile } = require("node:fs/promises");
			writeFile(args[0], json, "utf-8");
			return `Exported to ${args[0]}`;
		}
		return json;
	},

	import: ({ session, args }) => {
		if (args.length === 0) {
			throw new Error("Usage: :import <file-path>");
		}
		const { readFile } = require("node:fs/promises");
		const content = readFile(args[0], "utf-8");
		const entries = JSON.parse(content) as ReturnType<typeof session.export>;
		session.import(entries);
		return `Imported from ${args[0]}`;
	},

	clear: ({ session }) => {
		// Create a new session with cleared state
		const _entries = session.export();
		const currentLeaf = session.getCurrentLeaf();
		return `Cleared session. Previous leaf: ${currentLeaf?.slice(0, 8)}`;
	},
};

function formatTree(nodes: unknown[], depth = 0): string {
	let result = "";
	for (const node of nodes) {
		const n = node as { id: string; type: string; parentId: string | null; children: unknown[]; timestamp: string };
		const indent = "  ".repeat(depth);
		const prefix = n.parentId === null ? "●" : "├─";
		result += `${indent}${prefix} ${n.type}: ${n.id.slice(0, 8)}\n`;
		if (n.children.length > 0) {
			result += formatTree(n.children, depth + 1);
		}
	}
	return result;
}
