import {
	ApplicationMenu,
	BrowserWindow,
	Updater,
	defineElectrobunRPC,
} from "electrobun/bun";
import { getModel, getProviders } from "@mariozechner/pi-ai";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
	type ChatRPCSchema,
	type AuthStateResponse,
	type PermissionRequestMessage,
	type ProviderAuthInfo,
	type SendPromptRequest,
	type StreamEventMessage,
} from "../mainview/chat-rpc";
import {
	DEFAULT_CHAT_SETTINGS,
	type ReasoningEffort,
} from "../mainview/chat-settings";
import {
	getProviderEnvVar,
	resolveApiKey,
	resolveAuthState,
	removeCredential,
	setApiKey as storeApiKey,
} from "./auth-store";
import { refreshIfNeeded, startOAuthLogin, supportsOAuth } from "./oauth-login";
import {
	cancelAgentSession,
	initVm,
	respondPermission,
	sendAgentPrompt,
	setSessionModel,
	setSessionThoughtLevel,
} from "./agent-os-host";

type SessionMutationResponse = {
	ok: boolean;
	sessionId: string;
};

type BackendRPCSchema = ChatRPCSchema & {
	bun: ChatRPCSchema["bun"] & {
		messages: {
			sendStreamEvent: StreamEventMessage;
			permissionRequest: PermissionRequestMessage;
		};
	};
};

const DEV_SERVER_PORT = 5173;
const DEV_SERVER_URL = `http://localhost:${DEV_SERVER_PORT}`;
const DEFAULT_RPC_TIMEOUT_MS = 120000;
const DEFAULT_SYSTEM_PROMPT = "You are a helpful AI assistant.";
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

function createStreamId(): string {
	return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
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

const rpc = defineElectrobunRPC<BackendRPCSchema>("bun", {
	maxRequestTime: getRpcRequestTimeoutMs(),
	handlers: {
		requests: {
			getDefaults: () => DEFAULT_CHAT_SETTINGS,
			getAuthState: async (): Promise<AuthStateResponse> => createAuthState(),
			loginChatGPT: async (): Promise<AuthStateResponse> => {
				const state = createAuthState();
				if (state.connected) {
					state.message = `${DEFAULT_CHAT_SETTINGS.provider} uses API key authentication.`;
				}
				return state;
			},
			sendPrompt: async (payload: SendPromptRequest): Promise<{ streamId: string; sessionId: string }> => {
				const resolved = resolveSendDefaults(payload);

				if (supportsOAuth(resolved.provider)) {
					await refreshIfNeeded(resolved.provider);
				}

				const apiKey = resolveApiKey(resolved.provider);
				if (!apiKey) {
					throw new Error(getApiKeyMissingError(resolved.provider));
				}

				const model = getModel(
					resolved.provider as Parameters<typeof getModel>[0],
					resolved.model as Parameters<typeof getModel>[1],
				);
				const streamId = createStreamId();
				let sessionId = payload.sessionId ?? "";

				const session = await sendAgentPrompt({
					sessionId: payload.sessionId,
					provider: resolved.provider,
					model: model.id,
					thinkingLevel: resolved.reasoningEffort,
					messages: payload.messages,
					systemPrompt: payload.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
					onEvent: (event) => {
						rpc.send.sendStreamEvent({ streamId, event });
					},
					onPermissionRequest: (request) => {
						rpc.send.permissionRequest({
							sessionId,
							permissionId: request.permissionId,
							description: request.description,
							params: request.params,
						});
					},
				});

				sessionId = session.sessionId;
				return { streamId, sessionId };
			},
			cancelPrompt: async ({ sessionId }: { sessionId: string }): Promise<{ ok: boolean }> => {
				await cancelAgentSession(sessionId);
				return { ok: true };
			},
			respondPermission: async ({
				sessionId,
				permissionId,
				reply,
			}: {
				sessionId: string;
				permissionId: string;
				reply: "once" | "always" | "reject";
			}): Promise<{ ok: boolean }> => {
				await respondPermission(sessionId, permissionId, reply);
				return { ok: true };
			},
			setSessionModel: async ({
				sessionId,
				model,
			}: {
				sessionId: string;
				model: string;
			}): Promise<SessionMutationResponse> => {
				const result = await setSessionModel(sessionId, model);
				return { ok: result.ok, sessionId: result.sessionId };
			},
			setSessionThoughtLevel: async ({
				sessionId,
				level,
			}: {
				sessionId: string;
				level: ReasoningEffort;
			}): Promise<SessionMutationResponse> => {
				const result = await setSessionThoughtLevel(sessionId, level);
				return { ok: result.ok, sessionId: result.sessionId };
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
			setProviderApiKey: async (params: {
				providerId: string;
				apiKey: string;
			}): Promise<{ ok: boolean }> => {
				storeApiKey(params.providerId, params.apiKey);
				return { ok: true };
			},
			startOAuth: async (params: {
				providerId: string;
			}): Promise<{ ok: boolean; error?: string }> => {
				try {
					await startOAuthLogin(params.providerId);
					return { ok: true };
				} catch (err) {
					return { ok: false, error: err instanceof Error ? err.message : String(err) };
				}
			},
			removeProviderAuth: async (params: {
				providerId: string;
			}): Promise<{ ok: boolean }> => {
				removeCredential(params.providerId);
				return { ok: true };
			},
		},
	},
});

const appMenu: Parameters<typeof ApplicationMenu.setApplicationMenu>[0] = [
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

await initVm();

const url = await getMainViewUrl();

const mainWindow = new BrowserWindow({
	title: "Electrobun Chat",
	frame: {
		x: 0,
		y: 0,
		width: 960,
		height: 760,
	},
	url,
	rpc,
});

void mainWindow;

console.log("Svelte + Pi Chat app started!");
