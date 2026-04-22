import { appendFileSync } from "node:fs";
import path from "node:path";

const LOG_PATH = path.resolve(process.cwd(), "debug.log");

function formatBeijingTimestamp(date: Date): string {
	const formatter = new Intl.DateTimeFormat("en-GB", {
		timeZone: "Asia/Shanghai",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		fractionalSecondDigits: 3,
		hour12: false,
	});
	return formatter.format(date);
}

function _debug(...args: unknown[]): void {
	const timestamp = formatBeijingTimestamp(new Date());
	const message = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a, null, 2))).join(" ");
	appendFileSync(LOG_PATH, `[${timestamp}] ${message}\n`);
}

// 挂到 globalThis
(globalThis as typeof globalThis & { debug: typeof _debug }).debug = _debug;

// 全局类型声明，让任何文件都能直接写 debug() 不报错
declare global {
	var debug: (...args: unknown[]) => void;
}
