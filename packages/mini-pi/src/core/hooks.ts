import type { HookContext, Hooks } from "./types.js";

export class HookManager {
	private hooks: Hooks = {};

	register(hooks: Hooks): void {
		this.hooks = { ...this.hooks, ...hooks };
	}

	async executeBeforeToolCall(context: HookContext): Promise<void> {
		if (this.hooks.beforeToolCall) {
			await this.hooks.beforeToolCall(context);
		}
	}

	async executeAfterToolCall(context: HookContext): Promise<void> {
		if (this.hooks.afterToolCall) {
			await this.hooks.afterToolCall(context);
		}
	}

	async executeOnCompact(context: HookContext): Promise<void> {
		if (this.hooks.onCompact) {
			await this.hooks.onCompact(context);
		}
	}

	async executeOnTurnStart(context: HookContext): Promise<void> {
		if (this.hooks.onTurnStart) {
			await this.hooks.onTurnStart(context);
		}
	}

	async executeOnTurnEnd(context: HookContext): Promise<void> {
		if (this.hooks.onTurnEnd) {
			await this.hooks.onTurnEnd(context);
		}
	}
}
