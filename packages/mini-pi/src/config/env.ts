import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(process.cwd(), ".env") });

export interface Config {
	apiKey: string;
	apiUrl: string;
	model: string;
}

export const config: Config = {
	apiKey: process.env.API_KEY || "",
	apiUrl: process.env.API_URL || "https://api.openai.com/v1",
	model: process.env.MODEL || "gpt-4o",
};

export function validateConfig(): void {
	if (!config.apiKey) {
		throw new Error("API_KEY is required. Set it in .env file");
	}
}
