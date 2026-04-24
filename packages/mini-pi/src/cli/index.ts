#!/usr/bin/env node
import { AIClient } from "../ai/index.js";
import { config, validateConfig } from "../config/index.js";
import { AgentLoop } from "../core/agent-loop.js";
import { InMemorySession } from "../core/session.js";
import { builtinTools } from "../tools/index.js";
import { REPL } from "./repl.js";

async function main(): Promise<void> {
	try {
		validateConfig();

		const aiClient = new AIClient({
			apiKey: config.apiKey,
			apiUrl: config.apiUrl,
			model: config.model,
		});

		const session = new InMemorySession();

		const agentLoop = new AgentLoop({
			aiClient,
			session,
			tools: builtinTools,
		});

		const repl = new REPL(agentLoop, session);
		await repl.start();
	} catch (error) {
		if (error instanceof Error) {
			console.error(`Error: ${error.message}`);
		} else {
			console.error("Unknown error occurred");
		}
		process.exit(1);
	}
}

main();
