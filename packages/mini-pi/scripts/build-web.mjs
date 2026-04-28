/**
 * scripts/build-web.mjs — 打包前端到 dist/web/client/。
 *
 * 调用方：`npm run build:web`（由 `npm run build` 顺带触发）。
 *
 * 教学意义：展示最轻量的"tsgo 编译后端 + esbuild 打包前端"组合，
 * 不引 Vite、不引 Next —— 让学习者看清每一步做了什么。
 */

import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");
const src = resolve(pkgRoot, "src/web/client");
const outDir = resolve(pkgRoot, "dist/web/client");

mkdirSync(outDir, { recursive: true });

await build({
	entryPoints: [resolve(src, "main.tsx")],
	bundle: true,
	format: "esm",
	target: ["es2022"],
	platform: "browser",
	outfile: resolve(outDir, "client.js"),
	jsx: "automatic",
	loader: { ".tsx": "tsx", ".ts": "ts" },
	minify: true,
	sourcemap: true,
});

copyFileSync(resolve(src, "index.html"), resolve(outDir, "index.html"));

console.log(`Built client to ${outDir}`);
