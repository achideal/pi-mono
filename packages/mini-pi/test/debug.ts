import { appendFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const LOG_PATH = resolve(TEST_DIR, "debug.log");
const BEIJING_TIMESTAMP_FORMATTER = new Intl.DateTimeFormat("en-CA", {
	timeZone: "Asia/Shanghai",
	year: "numeric",
	month: "2-digit",
	day: "2-digit",
	hour: "2-digit",
	minute: "2-digit",
	second: "2-digit",
	fractionalSecondDigits: 3,
	hour12: false,
});

type DateTimePartType = "year" | "month" | "day" | "hour" | "minute" | "second" | "fractionalSecond";
type DebugFn = (...args: unknown[]) => void;

function formatBeijingTimestamp(date: Date): string {
	const values = {} as Record<DateTimePartType, string>;

	for (const part of BEIJING_TIMESTAMP_FORMATTER.formatToParts(date)) {
		if (
			part.type === "year" ||
			part.type === "month" ||
			part.type === "day" ||
			part.type === "hour" ||
			part.type === "minute" ||
			part.type === "second" ||
			part.type === "fractionalSecond"
		) {
			values[part.type] = part.value;
		}
	}

	return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second}.${values.fractionalSecond} UTC+8`;
}

function formatDebugValue(value: unknown): string {
	if (typeof value === "string") {
		return value;
	}

	return inspect(value, {
		colors: false,
		compact: false,
		depth: null,
	});
}

export function clearDebugLog(): void {
	writeFileSync(LOG_PATH, "", "utf-8");
}

function writeDebug(...args: unknown[]): void {
	const timestamp = formatBeijingTimestamp(new Date());
	const line = args.map((arg) => formatDebugValue(arg)).join(" ");
	appendFileSync(LOG_PATH, `[${timestamp}] ${line}\n\n\n`, "utf-8");
}

declare global {
	var debug: DebugFn;
}

globalThis.debug = writeDebug;

export { writeDebug as debug };
export { LOG_PATH as DEBUG_LOG_PATH };
