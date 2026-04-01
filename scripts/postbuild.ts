#!/usr/bin/env bun
// Post-build: copy external packages into the .app bundle so Bun resolves them at runtime.
// Packages marked `external` in Bun.build() are not inlined, so they need to exist on disk
// inside the app bundle's node_modules.

import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

const buildDir = process.env.ELECTROBUN_BUILD_DIR;
const appName = process.env.ELECTROBUN_APP_NAME;
if (!buildDir || !appName) {
	console.error("postbuild: ELECTROBUN_BUILD_DIR and ELECTROBUN_APP_NAME env vars required");
	process.exit(1);
}

const appCodeDir = join(
	buildDir,
	`${appName}.app`,
	"Contents",
	"Resources",
	"app",
);
const nodeModulesDest = join(appCodeDir, "node_modules");
const projectRoot = join(import.meta.dir, "..");
const src = (rel: string) => join(projectRoot, "node_modules", rel);

// Scopes to copy entirely (all packages under @scope/)
const scopes = [
	"@rivet-dev",
	"@secure-exec",
	"@esbuild",
	"@mariozechner",
	"@agentclientprotocol",
];

// Individual packages to copy
const packages = [
	"secure-exec",
	"node-stdlib-browser",
	"esbuild",
	"web-streams-polyfill",
	"cbor-x",
	"cjs-module-lexer",
	"es-module-lexer",
	"pkg-dir",
	"better-sqlite3",
	"pyodide",
];

let copied = 0;

for (const scope of scopes) {
	const scopeSrc = src(scope);
	if (!existsSync(scopeSrc)) {
		console.warn(`postbuild: skipping scope ${scope}/ (not found)`);
		continue;
	}
	for (const entry of readdirSync(scopeSrc)) {
		const rel = `${scope}/${entry}`;
		const source = src(rel);
		const dest = join(nodeModulesDest, rel);
		if (!existsSync(source)) continue;
		mkdirSync(join(dest, ".."), { recursive: true });
		cpSync(source, dest, { recursive: true, dereference: true });
		copied++;
	}
}

for (const pkg of packages) {
	const source = src(pkg);
	const dest = join(nodeModulesDest, pkg);
	if (!existsSync(source)) continue;
	mkdirSync(join(dest, ".."), { recursive: true });
	cpSync(source, dest, { recursive: true, dereference: true });
	copied++;
}

console.log(`postbuild: copied ${copied} packages to bundle`);
