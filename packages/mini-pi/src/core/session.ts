import { randomUUID } from "node:crypto";
import type { Message, SessionEntry, SessionManager, TreeNode } from "./types.js";

export class InMemorySession implements SessionManager {
	private entries: Map<string, SessionEntry> = new Map();
	private leafId: string | null = null;

	append(entry: Omit<SessionEntry, "id" | "timestamp">): string {
		const id = randomUUID();
		const timestamp = new Date().toISOString();
		const newEntry: SessionEntry = { ...entry, id, timestamp };

		this.entries.set(id, newEntry);
		this.leafId = id;
		return id;
	}

	branch(fromId: string): string {
		if (!this.entries.has(fromId)) {
			throw new Error(`Entry ${fromId} not found`);
		}

		const branchId = randomUUID();
		const timestamp = new Date().toISOString();

		const branchEntry: SessionEntry = {
			id: branchId,
			type: "branch_start",
			parentId: null,
			timestamp,
			data: { fromId, branchId },
		};

		this.entries.set(branchId, branchEntry);
		this.leafId = branchId;
		return branchId;
	}

	getBranch(leafId?: string): Message[] {
		const startId = leafId || this.leafId;
		if (!startId) {
			return [];
		}

		const messages: Message[] = [];
		let currentId: string | null = startId;

		while (currentId) {
			const entry = this.entries.get(currentId);
			if (!entry) break;

			if (entry.type === "message") {
				messages.unshift(entry.data as Message);
			} else if (entry.type === "compaction") {
				// Compaction entries are not included in message list
				// They just mark a point in the tree
			}

			currentId = entry.parentId;
		}

		return messages;
	}

	getTree(): TreeNode[] {
		const rootNodes: TreeNode[] = [];
		const childrenMap = new Map<string, TreeNode[]>();

		// Build nodes and children mapping
		for (const [id, entry] of this.entries) {
			const node: TreeNode = {
				id,
				type: entry.type,
				parentId: entry.parentId,
				children: [],
				timestamp: entry.timestamp,
			};
			childrenMap.set(id, node.children);

			if (!entry.parentId) {
				rootNodes.push(node);
			}
		}

		// Link children to parents
		for (const [id, entry] of this.entries) {
			if (entry.parentId) {
				const parentChildren = childrenMap.get(entry.parentId);
				const node = Array.from(childrenMap.entries()).find(([nid]) => nid === id)?.[1];
				if (parentChildren && node) {
					parentChildren.push(node[0]);
				}
			}
		}

		// Recursively build tree structure
		const buildTree = (nodes: TreeNode[]): TreeNode[] => {
			return nodes.map((node) => ({
				...node,
				children: buildTree(childrenMap.get(node.id) || []),
			}));
		};

		return buildTree(rootNodes);
	}

	getCurrentLeaf(): string | null {
		return this.leafId;
	}

	setLeaf(id: string): void {
		if (!this.entries.has(id)) {
			throw new Error(`Entry ${id} not found`);
		}
		this.leafId = id;
	}

	export(): SessionEntry[] {
		return Array.from(this.entries.values());
	}

	import(entries: SessionEntry[]): void {
		this.entries.clear();
		for (const entry of entries) {
			this.entries.set(entry.id, entry);
		}
		// Find the most recent message as leaf
		let latestTime = "";
		for (const [id, entry] of this.entries) {
			if (entry.type === "message" && entry.timestamp >= latestTime) {
				latestTime = entry.timestamp;
				this.leafId = id;
			}
		}
	}
}
