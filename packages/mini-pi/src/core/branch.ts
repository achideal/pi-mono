import type { SessionManager } from "./types.js";

export function createBranch(session: SessionManager, fromEntryId: string): string {
	return session.branch(fromEntryId);
}

export function switchBranch(session: SessionManager, branchId: string): void {
	session.setLeaf(branchId);
}

export function listBranches(session: SessionManager): Array<{ id: string; timestamp: string }> {
	const entries = session.export();
	return entries
		.filter((e) => e.parentId === null || e.type === "branch_start")
		.map((e) => ({ id: e.id, timestamp: e.timestamp }));
}

export function getBranchPath(session: SessionManager, leafId: string): string[] {
	const entries = session.export();
	const path: string[] = [];
	let currentId: string | null = leafId;

	while (currentId) {
		path.unshift(currentId);
		const entry = entries.find((e) => e.id === currentId);
		currentId = entry?.parentId || null;
	}

	return path;
}
