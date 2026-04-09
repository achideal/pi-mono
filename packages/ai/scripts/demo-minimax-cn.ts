import { completeSimple, getModel, streamSimple } from "../src/index.ts";

const MODEL_PROVIDER = "minimax-cn";
const MODEL_ID = "MiniMax-M2.7-highspeed";
const API_KEY_ENV = "MINIMAX_CN_API_KEY";
const DEFAULT_PROMPT = "中文自我介绍一下。";

function parseArgs(argv: string[]): { stream: boolean; prompt: string } {
	let stream = false;
	const promptParts: string[] = [];

	for (const arg of argv) {
		if (arg === "--stream") {
			stream = true;
			continue;
		}
		promptParts.push(arg);
	}

	return {
		stream,
		prompt: promptParts.join(" ").trim() || DEFAULT_PROMPT,
	};
}

async function run(): Promise<void> {
	const apiKey = process.env[API_KEY_ENV];
	if (!apiKey) {
		console.error(`Missing ${API_KEY_ENV}. Set it and rerun.`);
		process.exitCode = 1;
		return;
	}

	const { stream, prompt } = parseArgs(process.argv.slice(2));
	console.log('args:', process.argv);
	const model = getModel(MODEL_PROVIDER, MODEL_ID);
	console.log('model:', model);
	const context = {
		messages: [
			{
				role: "user" as const,
				content: prompt,
				timestamp: Date.now(),
			},
		],
	};

	console.log(`model: ${model.provider} ${model.id} ${model.api}`);
	console.log(`mode: ${stream ? "stream" : "complete"}`);
	console.log(`prompt: ${prompt}`);
	console.log("");

	if (stream) {
		const result = streamSimple(model, context, { apiKey });
		for await (const event of result) {
			if (event.type === "text_delta") {
				process.stdout.write(event.delta);
			}
		}
		console.log("");
		return;
	}

	const response = await completeSimple(model, context, { apiKey });
	const text = response.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");

	console.log(text);
	console.log("");
	console.log("usage:");
	console.log(JSON.stringify(response.usage, null, 2));
}

run().catch((error: unknown) => {
	const message = error instanceof Error ? error.message : String(error);
	console.error(message);
	process.exitCode = 1;
});
