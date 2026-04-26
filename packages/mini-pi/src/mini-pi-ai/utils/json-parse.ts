import { parse as partialParse } from "partial-json";

export function parseStreamingJson<T extends Record<string, unknown> = Record<string, unknown>>(
	partialJson: string | undefined,
): T {
	if (!partialJson || partialJson.trim() === "") {
		return {} as T;
	}

	try {
		return JSON.parse(partialJson) as T;
	} catch {
		try {
			const result = partialParse(partialJson);
			return (result ?? {}) as T;
		} catch {
			return {} as T;
		}
	}
}
