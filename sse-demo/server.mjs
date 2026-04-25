import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import http from "node:http";
import { extname, join } from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const host = "127.0.0.1";
const port = Number(process.env.PORT ?? 3030);
const rootDir = fileURLToPath(new URL(".", import.meta.url));
const clients = new Set();

let transcript = "";
let chunkCount = 0;

function sendEvent(response, event, payload) {
	response.write(`event: ${event}\n`);
	for (const line of JSON.stringify(payload).split("\n")) {
		response.write(`data: ${line}\n`);
	}
	response.write("\n");
}

function broadcast(event, payload) {
	for (const client of clients) {
		sendEvent(client, event, payload);
	}
}

function chunkFromLine(line) {
	return line.length === 0 ? "\n" : line;
}

function printInstructions() {
	console.log("");
	console.log("SSE demo server is running.");
	console.log(`Open http://${host}:${port} in your browser.`);
	console.log("");
	console.log("Type one line and press Enter to stream one chunk.");
	console.log("Special commands:");
	console.log("  /reset  Clear the client transcript");
	console.log("  /done   Send a done event");
	console.log("  /exit   Stop the server");
	console.log("  /help   Print these instructions again");
	console.log("");
	console.log("Tip: an empty line sends a newline chunk.");
	console.log("");
}

async function serveFile(response, filePath) {
	const extension = extname(filePath);
	const contentType =
		extension === ".html"
			? "text/html; charset=utf-8"
			: extension === ".js"
				? "text/javascript; charset=utf-8"
				: "text/plain; charset=utf-8";

	try {
		await stat(filePath);
		response.writeHead(200, {
			"Content-Type": contentType,
			"Cache-Control": "no-store",
		});
		createReadStream(filePath).pipe(response);
	} catch {
		response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
		response.end("Not found");
	}
}

const server = http.createServer(async (request, response) => {
	const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${host}:${port}`}`);

	if (url.pathname === "/events") {
		response.writeHead(200, {
			"Content-Type": "text/event-stream; charset=utf-8",
			"Cache-Control": "no-store",
			Connection: "keep-alive",
		});

		response.write(": connected\n\n");
		clients.add(response);
		sendEvent(response, "snapshot", { transcript, chunkCount });

		request.on("close", () => {
			clients.delete(response);
		});
		return;
	}

	if (url.pathname === "/" || url.pathname === "/index.html") {
		await serveFile(response, join(rootDir, "index.html"));
		return;
	}

	response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
	response.end("Not found");
});

const input = readline.createInterface({
	input: process.stdin,
	output: process.stdout,
	terminal: true,
});

function shutdown() {
	for (const client of clients) {
		client.end();
	}
	input.close();
	server.close(() => {
		process.exit(0);
	});
}

input.on("line", (line) => {
	if (line === "/help") {
		printInstructions();
		return;
	}

	if (line === "/reset") {
		transcript = "";
		chunkCount = 0;
		broadcast("reset", { transcript, chunkCount });
		console.log("Client transcript reset.");
		return;
	}

	if (line === "/done") {
		broadcast("done", { transcript, chunkCount });
		console.log("Done event sent.");
		return;
	}

	if (line === "/exit") {
		console.log("Stopping server.");
		shutdown();
		return;
	}

	const chunk = chunkFromLine(line);
	transcript += chunk;
	chunkCount += 1;
	broadcast("chunk", { text: chunk, transcript, chunkCount });
	console.log(`Chunk ${chunkCount} sent.`);
});

server.listen(port, host, () => {
	printInstructions();
});

process.on("SIGINT", () => {
	console.log("");
	console.log("Stopping server.");
	shutdown();
});
