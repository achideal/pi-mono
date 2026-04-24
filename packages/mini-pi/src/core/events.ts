import type { AgentEvent, AgentEventType } from "./types.js";

type EventListener = (event: AgentEvent) => void | Promise<void>;

export class EventEmitter {
	private listeners: Map<AgentEventType, EventListener[]> = new Map();

	on(eventType: AgentEventType, listener: EventListener): void {
		const existing = this.listeners.get(eventType) || [];
		existing.push(listener);
		this.listeners.set(eventType, existing);
	}

	off(eventType: AgentEventType, listener: EventListener): void {
		const existing = this.listeners.get(eventType);
		if (existing) {
			const filtered = existing.filter((l) => l !== listener);
			this.listeners.set(eventType, filtered);
		}
	}

	async emit(event: AgentEvent): Promise<void> {
		const listeners = this.listeners.get(event.type) || [];
		for (const listener of listeners) {
			await listener(event);
		}
	}

	clear(): void {
		this.listeners.clear();
	}
}
