import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Api, Model, PublicApi } from "./types.js";

export interface MiniPiEnvironment {
	values: Record<string, string>;
	envFilePath: string;
	hasEnvFile: boolean;
}

export interface ResolvedEndpointUrl {
	publicApi: PublicApi;
	internalApi: Api;
	endpointUrl: string;
	baseUrl: string;
}

export interface ConfiguredModelSource {
	label: string;
}

export interface ConfiguredModel<TApi extends Api = Api> extends Model<TApi> {
	apiKey: string;
	source: ConfiguredModelSource;
}

const CHAT_COMPLETIONS_SUFFIX = "/chat/completions";
const RESPONSES_SUFFIX = "/responses";

export function getDefaultEnvFilePath(): string {
	return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", ".env");
}

export function parseDotEnv(content: string): Record<string, string> {
	const parsed: Record<string, string> = {};

	for (const rawLine of content.split(/\r?\n/u)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;

		const normalizedLine = line.startsWith("export ") ? line.slice("export ".length) : line;
		const separatorIndex = normalizedLine.indexOf("=");
		if (separatorIndex === -1) continue;

		const key = normalizedLine.slice(0, separatorIndex).trim();
		if (!key) continue;

		let value = normalizedLine.slice(separatorIndex + 1).trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}

		parsed[key] = value;
	}

	return parsed;
}

export function loadMiniPiEnvironment(options?: { env?: NodeJS.ProcessEnv; envFilePath?: string }): MiniPiEnvironment {
	const envFilePath = options?.envFilePath || getDefaultEnvFilePath();
	const hasEnvFile = existsSync(envFilePath);
	const fileValues = hasEnvFile ? parseDotEnv(readFileSync(envFilePath, "utf-8")) : {};

	const values: Record<string, string> = { ...fileValues };
	for (const [key, value] of Object.entries(options?.env ?? process.env)) {
		if (typeof value === "string") {
			values[key] = value;
		}
	}

	return {
		values,
		envFilePath,
		hasEnvFile,
	};
}

export function parsePublicApi(value: string | undefined): PublicApi | undefined {
	if (!value) return undefined;
	if (value === "openai" || value === "openai-completions") return "openai";
	if (value === "openai-response" || value === "openai-responses") return "openai-response";
	throw new Error(`Unsupported API value "${value}". Expected "openai" or "openai-response".`);
}

export function parseEndpointUrl(rawUrl: string, fallbackApi?: PublicApi): ResolvedEndpointUrl {
	const url = new URL(rawUrl);
	const pathname = normalizePathname(url.pathname);

	if (pathname.endsWith(CHAT_COMPLETIONS_SUFFIX)) {
		return {
			publicApi: "openai",
			internalApi: "openai-completions",
			endpointUrl: `${url.origin}${pathname}`,
			baseUrl: `${url.origin}${pathname.slice(0, -CHAT_COMPLETIONS_SUFFIX.length) || "/v1"}`,
		};
	}

	if (pathname.endsWith(RESPONSES_SUFFIX)) {
		return {
			publicApi: "openai-response",
			internalApi: "openai-responses",
			endpointUrl: `${url.origin}${pathname}`,
			baseUrl: `${url.origin}${pathname.slice(0, -RESPONSES_SUFFIX.length) || "/v1"}`,
		};
	}

	if (!fallbackApi) {
		throw new Error(
			`Unsupported endpoint URL "${rawUrl}". Expected a URL ending with "${CHAT_COMPLETIONS_SUFFIX}" or "${RESPONSES_SUFFIX}".`,
		);
	}

	const basePath = pathname === "/" ? "/v1" : pathname;
	const normalizedBasePath = basePath.endsWith("/v1") ? basePath : `${basePath}/v1`;
	const suffix = fallbackApi === "openai" ? CHAT_COMPLETIONS_SUFFIX : RESPONSES_SUFFIX;

	return {
		publicApi: fallbackApi,
		internalApi: fallbackApi === "openai" ? "openai-completions" : "openai-responses",
		endpointUrl: `${url.origin}${normalizedBasePath}${suffix}`,
		baseUrl: `${url.origin}${normalizedBasePath}`,
	};
}

export function loadConfiguredModels(options?: { env?: NodeJS.ProcessEnv; envFilePath?: string }): ConfiguredModel[] {
	const environment = loadMiniPiEnvironment(options);
	const { values } = environment;
	const configured = new Map<Api, ConfiguredModel>();

	addExplicitConfig(configured, values, "MINI_PI_CHAT", "openai", "explicit chat endpoint");
	addExplicitConfig(configured, values, "MINI_PI_RESPONSES", "openai-response", "explicit responses endpoint");

	const genericUrl = values.API_URL?.trim();
	const genericKey = values.API_KEY?.trim();
	const genericModel = values.MODEL?.trim();
	const genericApi = parsePublicApi(values.API?.trim());

	if (genericUrl || genericKey || genericModel) {
		assertCompleteConfig(
			{ url: genericUrl, apiKey: genericKey, model: genericModel },
			"generic API_*/MODEL env vars",
		);

		const parsed = parseEndpointUrl(genericUrl!, genericApi);
		if (!configured.has(parsed.internalApi)) {
			configured.set(
				parsed.internalApi,
				createConfiguredModel(parsed, genericModel!, genericKey!, parsed.publicApi !== "openai", {
					label: "generic API_*/MODEL env vars",
				}),
			);
		}
	}

	return Array.from(configured.values());
}

export function loadConfiguredModel(
	api?: PublicApi | Api,
	options?: {
		env?: NodeJS.ProcessEnv;
		envFilePath?: string;
	},
): ConfiguredModel {
	const models = loadConfiguredModels(options);
	if (models.length === 0) {
		throw new Error("No mini-pi models configured. Set MINI_PI_* or API_* environment variables first.");
	}

	if (!api) {
		if (models.length === 1) {
			return models[0];
		}
		throw new Error("Multiple mini-pi models are configured. Specify which API to load.");
	}

	const internalApi = mapApiAlias(api);
	const model = models.find((item) => item.api === internalApi);
	if (!model) {
		throw new Error(`No mini-pi model configured for API "${api}".`);
	}
	return model;
}

function addExplicitConfig(
	configured: Map<Api, ConfiguredModel>,
	values: Record<string, string>,
	prefix: "MINI_PI_CHAT" | "MINI_PI_RESPONSES",
	api: PublicApi,
	label: string,
): void {
	const url = values[`${prefix}_API_URL`]?.trim();
	const apiKey = values[`${prefix}_API_KEY`]?.trim();
	const model = values[`${prefix}_MODEL`]?.trim();

	if (!url && !apiKey && !model) {
		return;
	}

	assertCompleteConfig({ url, apiKey, model }, label);
	const parsed = parseEndpointUrl(url!, api);
	configured.set(
		parsed.internalApi,
		createConfiguredModel(parsed, model!, apiKey!, parsed.publicApi !== "openai", { label }),
	);
}

function assertCompleteConfig(
	config: { url?: string; apiKey?: string; model?: string },
	label: string,
): asserts config is { url: string; apiKey: string; model: string } {
	if (config.url && config.apiKey && config.model) {
		return;
	}

	throw new Error(`Incomplete ${label} configuration. URL, API key, and model must all be set together.`);
}

function createConfiguredModel(
	parsed: ResolvedEndpointUrl,
	modelId: string,
	apiKey: string,
	reasoning: boolean,
	source: ConfiguredModelSource,
): ConfiguredModel {
	return {
		id: modelId,
		name: modelId,
		api: parsed.internalApi,
		provider: "openai-compatible",
		baseUrl: parsed.baseUrl,
		endpointUrl: parsed.endpointUrl,
		reasoning,
		input: ["text"],
		maxTokens: 32000,
		apiKey,
		source,
	};
}

function normalizePathname(pathname: string): string {
	const normalized = pathname.replace(/\/+$/u, "");
	return normalized || "/";
}

function mapApiAlias(api: PublicApi | Api): Api {
	if (api === "openai" || api === "openai-completions") return "openai-completions";
	return "openai-responses";
}
