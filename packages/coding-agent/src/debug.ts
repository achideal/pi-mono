import { appendFileSync } from "node:fs";

const LOG_PATH = "./../../debug.log";

function _debug(...args: unknown[]): void {
	const timestamp = new Date().toISOString().slice(11, 23);
	const message = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a, null, 2))).join(" ");
	appendFileSync(LOG_PATH, `[${timestamp}] ${message}\n`);
}

// 挂到 globalThis
(globalThis as any).debug = _debug;

// 全局类型声明，让任何文件都能直接写 debug() 不报错
declare global {
	var debug: (...args: unknown[]) => void;
}
