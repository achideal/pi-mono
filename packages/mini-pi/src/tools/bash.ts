import { spawn } from "node:child_process";
import type { ToolExecutor } from "../core/types.js";

export interface BashParams {
	command: string;
	timeout?: number;
}

export const bashTool: ToolExecutor = {
	name: "bash",
	execute: async (params: unknown) => {
		const { command, timeout = 120000 } = params as BashParams;

		if (!command || typeof command !== "string") {
			throw new Error("command is required and must be a string");
		}

		return new Promise<string>((resolve, reject) => {
			const [cmd, ...args] = command.split(" ");
			const proc = spawn(cmd, args, { shell: true });

			let stdout = "";
			let stderr = "";

			proc.stdout?.on("data", (data) => {
				stdout += data.toString();
			});

			proc.stderr?.on("data", (data) => {
				stderr += data.toString();
			});

			const timer = setTimeout(() => {
				proc.kill();
				reject(new Error(`Command timed out after ${timeout}ms`));
			}, timeout);

			proc.on("close", (code) => {
				clearTimeout(timer);
				if (code === 0) {
					resolve(stdout);
				} else {
					reject(new Error(`Command failed with exit code ${code}\n${stderr}`));
				}
			});

			proc.on("error", (error) => {
				clearTimeout(timer);
				reject(error);
			});
		});
	},
};
