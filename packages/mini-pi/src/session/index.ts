/**
 * session 层公共导出。
 */

export {
	type CompactionRequest,
	type CompactionResult,
	compact,
	DEFAULT_COMPACTION_POLICY,
} from "./compactor.js";
export { FsSessionBackend, type FsSessionBackendOptions } from "./fs-backend.js";
export { InMemorySessionBackend } from "./memory-backend.js";
export { isSessionHeader, SessionStore } from "./session-store.js";
export type {
	CompactionEntry,
	CompactionPolicy,
	MessageEntry,
	ModelChangeEntry,
	SessionBackend,
	SessionEntry,
	SessionEntryBase,
	SessionFileRecord,
	SessionHeader,
	SessionSummary,
} from "./types.js";
