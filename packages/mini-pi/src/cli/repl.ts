import { stdout } from "node:process";
import { createInterface } from "node:readline";
import type { AgentLoop } from "../core/agent-loop.js";
import type { SessionManager } from "../core/types.js";

export class REPL {
	private agentLoop: AgentLoop;
	private session: SessionManager;
	private rl: ReturnType<typeof createInterface>;
	private running = false;

	constructor(agentLoop: AgentLoop, session: SessionManager) {
		this.agentLoop = agentLoop;
		this.session = session;
		this.rl = createInterface({
			input: process.stdin,
			output: process.stdout,
		});

		// Setup event listeners
		this.agentLoop.on("text_delta", (event: unknown) => {
			const data = (event as { data: { delta: string } }).data;
			if (data.delta) {
				stdout.write(data.delta);
			}
		});

		this.agentLoop.on("toolcall_start", (event: unknown) => {
			const data = (event as { data: { name: string } }).data;
			stdout.write(`\n\n[Running: ${data.name}]\n`);
		});

		this.agentLoop.on("toolcall_end", (event: unknown) => {
			const data = (event as { data: { result: string } }).data;
			const result = data.result;
			const truncated = result.length > 200 ? `${result.slice(0, 200)}...` : result;
			stdout.write(`[Done: ${truncated}]\n\n`);
		});
	}

	async start(): Promise<void> {
		this.running = true;

		// Print welcome message
		this.printWelcome();

		while (this.running) {
			const input = await this.prompt();

			if (!input) {
				continue;
			}

			if (input.startsWith(":")) {
				await this.handleCommand(input);
				continue;
			}

			try {
				await this.agentLoop.run(input);
				stdout.write("\n");
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error);
				stdout.write(`\nError: ${errorMessage}\n\n`);
			}
		}

		this.rl.close();
	}

	private prompt(): Promise<string> {
		return new Promise((resolve) => {
			this.rl.question("> ", resolve);
		});
	}

	private printWelcome(): void {
		stdout.write(`
╔════════════════════════════════════════╗
║          mini-pi REPL v0.1.0           ║
║     A minimal AI agent with tools      ║
╚════════════════════════════════════════╝

Commands:
  :quit       - Exit the REPL
  :tree       - Show session tree
  :branch     - Create a new branch
  :switch     - Switch to a different branch
  :help       - Show this help message

`);
	}

	private async handleCommand(input: string): Promise<void> {
		const [command, ...args] = input.split(" ");

		switch (command) {
			case ":quit":
			case ":q":
				this.running = false;
				this.agentLoop.stop();
				break;

			case ":help":
			case ":h":
				this.printWelcome();
				break;

			case ":tree":
			case ":t":
				this.printTree();
				break;

			case ":branch":
			case ":b":
				if (args.length === 0) {
					stdout.write("Usage: :branch <entry-id>\n");
				} else {
					try {
						const branchId = this.session.branch(args[0]);
						stdout.write(`Created branch: ${branchId}\n`);
					} catch (error) {
						stdout.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
					}
				}
				break;

			case ":switch":
			case ":s":
				if (args.length === 0) {
					this.printBranches();
				} else {
					try {
						this.session.setLeaf(args[0]);
						stdout.write(`Switched to branch: ${args[0]}\n`);
					} catch (error) {
						stdout.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
					}
				}
				break;

			default:
				stdout.write(`Unknown command: ${command}\nType :help for available commands\n`);
		}
	}

	private printTree(): void {
		const tree = this.session.getTree();
		stdout.write("\nSession Tree:\n");
		this.printTreeNode(tree, 0);
		stdout.write("\n");
	}

	private printTreeNode(nodes: unknown[], depth: number): void {
		for (const node of nodes) {
			const n = node as {
				id: string;
				type: string;
				parentId: string | null;
				children: unknown[];
				timestamp: string;
			};
			const indent = "  ".repeat(depth);
			const prefix = n.parentId === null ? "●" : "├─";
			stdout.write(`${indent}${prefix} ${n.type}: ${n.id.slice(0, 8)}\n`);
			if (n.children.length > 0) {
				this.printTreeNode(n.children, depth + 1);
			}
		}
	}

	private printBranches(): void {
		const entries = this.session.export();
		const branches = entries.filter((e) => e.parentId === null || e.type === "branch_start");
		stdout.write("\nAvailable branches:\n");
		for (const branch of branches) {
			const isCurrent = branch.id === this.session.getCurrentLeaf();
			const marker = isCurrent ? "*" : " ";
			stdout.write(`${marker} ${branch.id.slice(0, 8)} - ${branch.type}\n`);
		}
		stdout.write("\n");
	}

	stop(): void {
		this.running = false;
		this.agentLoop.stop();
	}
}
