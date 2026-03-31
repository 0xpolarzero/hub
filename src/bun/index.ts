import {
	BrowserWindow,
	Updater,
	defineElectrobunRPC,
	ApplicationMenu,
} from "electrobun/bun";
import { completeSimple, getModel } from "@mariozechner/pi-ai";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
	type ChatRPCSchema,
	type SendPromptRequest,
	type SendPromptResponse,
	type AuthStateResponse,
} from "../mainview/chat-rpc";
import { DEFAULT_CHAT_SETTINGS } from "../mainview/chat-settings";

const DEV_SERVER_PORT = 5173;
const DEV_SERVER_URL = `http://localhost:${DEV_SERVER_PORT}`;
const DEFAULT_RPC_TIMEOUT_MS = 120000;

const PROVIDER_ENV_VARS: Record<string, string> = {
	openai: "OPENAI_API_KEY",
	"azure-openai-responses": "AZURE_OPENAI_API_KEY",
	google: "GEMINI_API_KEY",
	groq: "GROQ_API_KEY",
	cerebras: "CEREBRAS_API_KEY",
	xai: "XAI_API_KEY",
	openrouter: "OPENROUTER_API_KEY",
	"vercel-ai-gateway": "AI_GATEWAY_API_KEY",
	zai: "ZAI_API_KEY",
	mistral: "MISTRAL_API_KEY",
	minimax: "MINIMAX_API_KEY",
	"minimax-cn": "MINIMAX_CN_API_KEY",
	huggingface: "HF_TOKEN",
	opencode: "OPENCODE_API_KEY",
	"opencode-go": "OPENCODE_API_KEY",
	"kimi-coding": "KIMI_API_KEY",
};

const E2E_ENV_FILES: string[] = [".env.e2e.local", ".env.e2e", ".env.local", ".env"];

function loadEnvFile(filePath: string): void {
	if (!existsSync(filePath)) return;

	try {
		const content = readFileSync(filePath, "utf8");
		for (const rawLine of content.split(/\r?\n/)) {
			const line = rawLine.trim();
			if (!line || line.startsWith("#")) continue;

			const equalsIndex = line.indexOf("=");
			if (equalsIndex < 0) continue;

			const key = line.slice(0, equalsIndex).trim();
			if (!key || process.env[key] !== undefined) continue;

			let value = line.slice(equalsIndex + 1).trim();
			if (
				(value.startsWith('"') && value.endsWith('"')) ||
				(value.startsWith("'") && value.endsWith("'"))
			) {
				value = value.slice(1, -1);
			}

			if (value) process.env[key] = value;
		}
	} catch {
		// Ignore malformed or unreadable env files.
	}
}

function loadRuntimeEnv(): void {
	const cwd = process.cwd();
	for (const file of E2E_ENV_FILES) {
		loadEnvFile(join(cwd, file));
	}
}

function getProviderEnvVar(provider: string): string | undefined {
	return PROVIDER_ENV_VARS[provider];
}

function getProviderApiKey(provider: string): string | undefined {
	const envVar = getProviderEnvVar(provider);
	if (!envVar) return undefined;

	const value = process.env[envVar];
	return value ? value.trim() : undefined;
}

function getRpcRequestTimeoutMs(): number {
	const source =
		process.env.ELECTROBUN_RPC_TIMEOUT_MS ??
		process.env.ELECTROBUN_RPC_REQUEST_TIMEOUT_MS ??
		process.env.VITE_ELECTROBUN_RPC_TIMEOUT_MS;

	const parsed = Number(source);
	if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_RPC_TIMEOUT_MS;

	return Math.trunc(parsed);
}

function getApiKeyMissingError(provider: string): string {
	const envVar = getProviderEnvVar(provider);
	if (!envVar) {
		return `No API key configured for provider "${provider}".`;
	}
	return `Missing ${envVar} for provider "${provider}".`;
}

async function getMainViewUrl(): Promise<string> {
	const channel = await Updater.localInfo.channel();
	if (channel === "dev") {
		try {
			await fetch(DEV_SERVER_URL, { method: "HEAD" });
			console.log(`HMR enabled: Using Vite dev server at ${DEV_SERVER_URL}`);
			return `${DEV_SERVER_URL}`;
		} catch {
			console.log("Vite dev server not running. Run 'bun run dev:hmr' for HMR support.");
		}
	}
	return "views://mainview/index.html";
}

function resolveSendDefaults(request: SendPromptRequest) {
	return {
		provider: request.provider || DEFAULT_CHAT_SETTINGS.provider,
		model: request.model || DEFAULT_CHAT_SETTINGS.model,
		reasoningEffort: request.reasoningEffort || DEFAULT_CHAT_SETTINGS.reasoningEffort,
	};
}

function createAuthState(): AuthStateResponse {
	const provider = DEFAULT_CHAT_SETTINGS.provider;
	const apiKey = getProviderApiKey(provider);
	if (!apiKey) {
		return {
			connected: false,
			message: getApiKeyMissingError(provider),
		};
	}

	return {
		connected: true,
		accountId: `${provider}-key`,
	};
}

const rpc = defineElectrobunRPC<ChatRPCSchema>("bun", {
	maxRequestTime: getRpcRequestTimeoutMs(),
	handlers: {
		requests: {
			getDefaults: () => DEFAULT_CHAT_SETTINGS,
			getAuthState: async () => createAuthState(),
			loginChatGPT: async () => {
				const state = createAuthState();
				if (state.connected) {
					state.message = `${DEFAULT_CHAT_SETTINGS.provider} uses API key authentication.`;
				}
				return state;
			},
			sendPrompt: async (payload) => {
				const resolved = resolveSendDefaults(payload);
				const apiKey = getProviderApiKey(resolved.provider);
				if (!apiKey) {
					throw new Error(getApiKeyMissingError(resolved.provider));
				}

				const model = getModel(resolved.provider as never, resolved.model as never);
				const context = { messages: payload.messages };
				const reasoning = resolved.reasoningEffort === "off" ? undefined : resolved.reasoningEffort;
				const response = await completeSimple(model, context, {
					apiKey,
					reasoning,
				});

				if (response.stopReason === "error") {
					throw new Error(response.errorMessage || "Chat request failed.");
				}

				return { message: response } as SendPromptResponse;
			},
		},
	},
});

const appMenu = [
	{
		label: "Electrobun Chat",
		submenu: [
			{ role: "about" },
			{ type: "separator" },
			{ role: "hide", accelerator: "CommandOrControl+H" },
			{ role: "hideOthers", accelerator: "CommandOrControl+Option+H" },
			{ role: "showAll" },
			{ type: "separator" },
			{ role: "quit", accelerator: "CommandOrControl+Q" },
		],
	},
	{
		label: "Edit",
		submenu: [
			{ role: "undo", accelerator: "CommandOrControl+Z" },
			{ role: "redo", accelerator: "CommandOrControl+Shift+Z" },
			{ type: "separator" },
			{ role: "cut", accelerator: "CommandOrControl+X" },
			{ role: "copy", accelerator: "CommandOrControl+C" },
			{ role: "paste", accelerator: "CommandOrControl+V" },
			{ role: "pasteAndMatchStyle" },
			{ role: "delete" },
			{ type: "separator" },
			{ role: "selectAll", accelerator: "CommandOrControl+A" },
		],
	},
	{
		label: "Window",
		submenu: [{ role: "close" }, { role: "minimize" }, { role: "zoom" }, { type: "separator" }, { role: "bringAllToFront" }],
	},
];

ApplicationMenu.setApplicationMenu(appMenu);

loadRuntimeEnv();

const url = await getMainViewUrl();

const mainWindow = new BrowserWindow({
	title: "Electrobun Chat",
	url,
	width: 960,
	height: 760,
	rpc,
});

console.log("Svelte + Pi Chat app started!");
