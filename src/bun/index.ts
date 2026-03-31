import {
	BrowserWindow,
	Updater,
	defineElectrobunRPC,
	ApplicationMenu,
} from "electrobun/bun";
import { streamSimple, getModel, getProviders } from "@mariozechner/pi-ai";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
	type ChatRPCSchema,
	type SendPromptRequest,
	type SendPromptResponse,
	type AuthStateResponse,
	type ProviderAuthInfo,
} from "../mainview/chat-rpc";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { DEFAULT_CHAT_SETTINGS } from "../mainview/chat-settings";
import { resolveApiKey, resolveAuthState, setApiKey as storeApiKey, removeCredential, getProviderEnvVar } from "./auth-store";
import { supportsOAuth, startOAuthLogin, refreshIfNeeded } from "./oauth-login";

const DEV_SERVER_PORT = 5173;
const DEV_SERVER_URL = `http://localhost:${DEV_SERVER_PORT}`;
const DEFAULT_RPC_TIMEOUT_MS = 120000;

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
	return `Missing ${envVar} for provider "${provider}". Add one in Settings.`;
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
	const state = resolveAuthState(provider);
	if (!state.connected) {
		return {
			connected: false,
			message: getApiKeyMissingError(provider),
		};
	}

	return {
		connected: true,
		accountId: `${provider}-${state.keyType}`,
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

				if (supportsOAuth(resolved.provider)) {
					await refreshIfNeeded(resolved.provider);
				}

				const apiKey = resolveApiKey(resolved.provider);
				if (!apiKey) {
					throw new Error(getApiKeyMissingError(resolved.provider));
				}

				const model = getModel(resolved.provider as never, resolved.model as never);
				const context = { systemPrompt: "You are a helpful assistant.", messages: payload.messages };
				const reasoning = resolved.reasoningEffort === "off" ? undefined : resolved.reasoningEffort;
				const eventStream = streamSimple(model, context, {
					apiKey,
					reasoning,
				});

				const streamId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

				void (async () => {
					try {
						for await (const event of eventStream) {
							rpc.send.sendStreamEvent({ streamId, event });
						}
					} catch (error) {
						const fallback: AssistantMessage = {
							role: "assistant",
							content: [{ type: "text", text: error instanceof Error ? error.message : "Streaming failed." }],
							api: `${resolved.provider}-responses`,
							provider: resolved.provider,
							model: resolved.model,
							timestamp: Date.now(),
							usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
							stopReason: "error",
							errorMessage: error instanceof Error ? error.message : "Streaming failed.",
						};
						rpc.send.sendStreamEvent({ streamId, event: { type: "error", reason: "error", error: fallback } });
					}
				})();

				return { streamId } as SendPromptResponse;
			},
			listProviderAuths: async (): Promise<ProviderAuthInfo[]> => {
				const providers = getProviders();
				return providers.map((id) => {
					const state = resolveAuthState(id);
					return {
						provider: id,
						hasKey: state.connected,
						keyType: state.keyType,
						supportsOAuth: supportsOAuth(id),
					};
				});
			},
			setProviderApiKey: async (params: { providerId: string; apiKey: string }) => {
				storeApiKey(params.providerId, params.apiKey);
				return { ok: true };
			},
			startOAuth: async (params: { providerId: string }) => {
				try {
					await startOAuthLogin(params.providerId);
					return { ok: true };
				} catch (err) {
					return { ok: false, error: err instanceof Error ? err.message : String(err) };
				}
			},
			removeProviderAuth: async (params: { providerId: string }) => {
				removeCredential(params.providerId);
				return { ok: true };
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
