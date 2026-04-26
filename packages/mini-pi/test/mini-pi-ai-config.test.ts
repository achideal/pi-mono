import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfiguredModel, loadConfiguredModels, parseEndpointUrl } from "../src/mini-pi-ai/config.js";

describe("mini-pi-ai config", () => {
	it("routes chat completions endpoints by pathname", () => {
		const parsed = parseEndpointUrl("https://api.vectorengine.cn/v1/chat/completions");

		expect(parsed.publicApi).toBe("openai");
		expect(parsed.internalApi).toBe("openai-completions");
		expect(parsed.baseUrl).toBe("https://api.vectorengine.cn/v1");
		expect(parsed.endpointUrl).toBe("https://api.vectorengine.cn/v1/chat/completions");
	});

	it("routes responses endpoints by pathname", () => {
		const parsed = parseEndpointUrl("https://api.vectorengine.cn/v1/responses");

		expect(parsed.publicApi).toBe("openai-response");
		expect(parsed.internalApi).toBe("openai-responses");
		expect(parsed.baseUrl).toBe("https://api.vectorengine.cn/v1");
		expect(parsed.endpointUrl).toBe("https://api.vectorengine.cn/v1/responses");
	});

	it("supports generic API_URL fallback with explicit API kind", () => {
		const envDir = mkdtempSync(join(tmpdir(), "mini-pi-config-"));
		const envPath = join(envDir, ".env");
		writeFileSync(envPath, "", "utf-8");

		const model = loadConfiguredModel(undefined, {
			envFilePath: envPath,
			env: {
				API: "openai-response",
				API_URL: "https://api.vectorengine.cn",
				API_KEY: "generic-key",
				MODEL: "gpt-5.4-mini",
			},
		});

		expect(model.api).toBe("openai-responses");
		expect(model.baseUrl).toBe("https://api.vectorengine.cn/v1");
		expect(model.endpointUrl).toBe("https://api.vectorengine.cn/v1/responses");
		expect(model.apiKey).toBe("generic-key");
	});

	it("lets process env override values from .env", () => {
		const envDir = mkdtempSync(join(tmpdir(), "mini-pi-config-"));
		const envPath = join(envDir, ".env");
		writeFileSync(
			envPath,
			[
				"MINI_PI_CHAT_API_URL=https://api.vectorengine.cn/v1/chat/completions",
				"MINI_PI_CHAT_API_KEY=file-key",
				"MINI_PI_CHAT_MODEL=file-model",
			].join("\n"),
			"utf-8",
		);

		const model = loadConfiguredModel("openai", {
			envFilePath: envPath,
			env: {
				MINI_PI_CHAT_MODEL: "env-model",
			},
		});

		expect(model.id).toBe("env-model");
		expect(model.apiKey).toBe("file-key");
	});

	it("requires explicit selection when both APIs are configured", () => {
		const envDir = mkdtempSync(join(tmpdir(), "mini-pi-config-"));
		const envPath = join(envDir, ".env");
		writeFileSync(envPath, "", "utf-8");

		const models = loadConfiguredModels({
			envFilePath: envPath,
			env: {
				MINI_PI_CHAT_API_URL: "https://api.vectorengine.cn/v1/chat/completions",
				MINI_PI_CHAT_API_KEY: "chat-key",
				MINI_PI_CHAT_MODEL: "chat-model",
				MINI_PI_RESPONSES_API_URL: "https://api.vectorengine.cn/v1/responses",
				MINI_PI_RESPONSES_API_KEY: "responses-key",
				MINI_PI_RESPONSES_MODEL: "responses-model",
			},
		});

		expect(models).toHaveLength(2);
		expect(() =>
			loadConfiguredModel(undefined, {
				envFilePath: envPath,
				env: {
					MINI_PI_CHAT_API_URL: "https://api.vectorengine.cn/v1/chat/completions",
					MINI_PI_CHAT_API_KEY: "chat-key",
					MINI_PI_CHAT_MODEL: "chat-model",
					MINI_PI_RESPONSES_API_URL: "https://api.vectorengine.cn/v1/responses",
					MINI_PI_RESPONSES_API_KEY: "responses-key",
					MINI_PI_RESPONSES_MODEL: "responses-model",
				},
			}),
		).toThrow("Multiple mini-pi models are configured");
	});
});
