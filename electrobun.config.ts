import type { ElectrobunConfig } from "electrobun";

const isE2E = Bun.env.E2E === "1" || Bun.env.ELECTROBUN_E2E === "1";
const isHeadlessE2E = Bun.env.ELECTROBUN_E2E_HEADLESS === "1";
const cdpPort = Bun.env.ELECTROBUN_E2E_CDP_PORT ?? "9333";
const e2eRenderer = {
	defaultRenderer: "cef",
	bundleCEF: true,
	chromiumFlags: {
		...(isHeadlessE2E ? { headless: true } : {}),
		"remote-debugging-port": cdpPort,
		"remote-debugging-address": "127.0.0.1",
		"remote-allow-origins": "*",
		"disable-dev-shm-usage": true,
		"disable-gpu": false,
	},
};
const regularRenderer = {
	bundleCEF: false,
};

export default {
	app: {
		name: "svelte-app",
		identifier: "svelteapp.electrobun.dev",
		version: "0.0.1",
	},
	scripts: {
		postBuild: "scripts/postbuild.ts",
	},
	build: {
		bun: {
			external: [
				"@rivet-dev/*",
				"secure-exec",
				"@secure-exec/*",
				"node-stdlib-browser",
				"esbuild",
				"@esbuild/*",
				"web-streams-polyfill",
				"cbor-x",
				"cjs-module-lexer",
				"es-module-lexer",
				"pkg-dir",
				"@mariozechner/*",
				"@agentclientprotocol/*",
				"better-sqlite3",
				"pyodide",
			],
		},
		// Vite builds to dist/, we copy from there
		copy: {
			"dist/index.html": "views/mainview/index.html",
			"dist/assets": "views/mainview/assets",
		},
		// Ignore Vite output in watch mode — HMR handles view rebuilds separately
		watchIgnore: ["dist/**"],
		mac: isE2E ? e2eRenderer : regularRenderer,
		linux: isE2E ? e2eRenderer : regularRenderer,
		win: isE2E ? e2eRenderer : regularRenderer,
	},
} satisfies ElectrobunConfig;
