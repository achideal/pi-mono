/**
 * mini-pi — 教学级最小可用 coding agent。
 *
 * 这是一个库式导出，真正的入口是 `web/server.ts`。
 * 每一层只导出它的"公共契约"，实现细节保留在子模块内。
 */

export * from "./agent/index.js";
export * from "./ai/index.js";
export * from "./session/index.js";
export * from "./tools/index.js";
