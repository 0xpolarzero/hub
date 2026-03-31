import {
	BrowserWindow,
	Updater,
	defineElectrobunRPC,
	ApplicationMenu,
} from "electrobun/bun";
import { completeSimple, getModel, type AssistantMessage } from "@mariozechner/pi-ai";
import { getOAuthApiKey, loginOpenAICodex, type OAuthCredentials } from "@mariozechner/pi-ai/oauth";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
	type ChatRPCSchema,
	type SendPromptRequest,
	type SendPromptResponse,
	type AuthStateResponse,
} from "../mainview/chat-rpc";
import { DEFAULT_CHAT_SETTINGS } from "../mainview/chat-settings";

const DEV_SERVER_PORT = 5173;
const DEV_SERVER_URL = `http://localhost:${DEV_SERVER_PORT}`;
const OPENAI_CODEX_PROVIDER = "openai-codex";
const OAUTH_CALLBACK_PORT = 1455;
const AUTH_FILE_PATH = join(
	Bun.env.HOME || process.env.HOME || process.env.USERPROFILE || process.cwd(),
	".hub",
	"chatgpt-auth.json",
);
const E2E_MODE = Bun.env.E2E === "1" || Bun.env.ELECTROBUN_E2E === "1";

const E2E_MESSAGE = "E2E mocked response from fixture mode.";

type StoredCredentials = Record<string, OAuthCredentials>;

interface ApiKeyResult {
	apiKey: string;
	newCredentials: OAuthCredentials;
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

async function readStoredCredentials(): Promise<StoredCredentials> {
	try {
		const data = await readFile(AUTH_FILE_PATH, "utf8");
		const parsed = JSON.parse(data);
		if (parsed && typeof parsed === "object") {
			return parsed as StoredCredentials;
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			console.error("Failed to read credentials file:", error);
		}
	}
	return {};
}

async function writeStoredCredentials(credentials: StoredCredentials): Promise<void> {
	const directory = dirname(AUTH_FILE_PATH);
	await mkdir(directory, { recursive: true });
	await writeFile(AUTH_FILE_PATH, JSON.stringify(credentials, null, 2), "utf8");
}

function invalidCredentials(value: unknown): value is OAuthCredentials {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<OAuthCredentials>;
	return (
		typeof candidate.access === "string" &&
		typeof candidate.refresh === "string" &&
		typeof candidate.expires === "number"
	);
}

async function getPidsUsingPort(port: number): Promise<number[]> {
	if (!["darwin", "linux"].includes(process.platform)) {
		return [];
	}

	try {
		const result = Bun.spawnSync(["lsof", "-nP", "-i", `tcp:${port}`, "-sTCP:LISTEN", "-t"], {
			stdout: "pipe",
			stderr: "ignore",
		});
		if (result.exitCode !== 0 || !result.stdout) {
			return [];
		}

		const text = new TextDecoder().decode(result.stdout).trim();
		if (!text) return [];
		return [...new Set(text.split(/\s+/).map((entry) => Number(entry)).filter((pid) => Number.isInteger(pid) && pid > 0))];
	} catch {
		return [];
	}
}

function canBindPort(port: number, host = "127.0.0.1"): Promise<boolean> {
	return new Promise((resolve) => {
		const server = createServer();
		server.once("error", () => {
			resolve(false);
		});
		server.listen({ port, host }, () => {
			server.close(() => resolve(true));
		});
	});
}

async function ensureOAuthCallbackPortAvailable(): Promise<void> {
	if (await canBindPort(OAUTH_CALLBACK_PORT)) {
		return;
	}

	const pids = await getPidsUsingPort(OAUTH_CALLBACK_PORT);
	if (pids.length === 0) {
		throw new Error(`Port ${OAUTH_CALLBACK_PORT} is already in use. Free the port and try again.`);
	}

	for (const pid of pids) {
		if (pid === process.pid) continue;
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// best-effort cleanup
		}
	}

	await new Promise((resolve) => setTimeout(resolve, 250));

	let portAvailable = false;
	for (let attempt = 0; attempt < 3; attempt++) {
		if (await canBindPort(OAUTH_CALLBACK_PORT)) {
			portAvailable = true;
			break;
		}
		await new Promise((resolve) => setTimeout(resolve, 150));
	}

	if (!portAvailable) {
		throw new Error(
			`Unable to free port ${OAUTH_CALLBACK_PORT} used by PID(s) ${pids.join(", ")}. Close those processes and retry.`,
		);
	}
}

async function getProviderCredentials(): Promise<OAuthCredentials | null> {
	const store = await readStoredCredentials();
	const candidate = store[OPENAI_CODEX_PROVIDER];
	return candidate && invalidCredentials(candidate) ? candidate : null;
}

async function saveProviderCredentials(credentials: OAuthCredentials): Promise<void> {
	const existing = await readStoredCredentials();
	existing[OPENAI_CODEX_PROVIDER] = credentials;
	await writeStoredCredentials(existing);
}

async function refreshAndGetApiKey(): Promise<ApiKeyResult | null> {
	const credentials = await getProviderCredentials();
	if (!credentials) return null;

	try {
		const resolved = await getOAuthApiKey(OPENAI_CODEX_PROVIDER, {
			[OPENAI_CODEX_PROVIDER]: credentials,
		});
		if (!resolved) return null;
		await saveProviderCredentials(resolved.newCredentials);
		return resolved;
	} catch (error) {
		console.error("Unable to load valid OAuth API key:", error);
		return null;
	}
}

function createE2EMessage(provider: string, model: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: E2E_MESSAGE }],
		api: "openai-codex-responses",
		provider,
		model,
		timestamp: Date.now(),
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 1,
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0,
			},
		},
		stopReason: "stop",
	};
}

function toAuthState(result: ApiKeyResult | null): AuthStateResponse {
	if (!result) return { connected: false };
	return {
		connected: true,
		accountId: (result.newCredentials.accountId as string | undefined) || undefined,
	};
}

function resolveSendDefaults(request: SendPromptRequest) {
	return {
		provider: request.provider || DEFAULT_CHAT_SETTINGS.provider,
		model: request.model || DEFAULT_CHAT_SETTINGS.model,
		reasoningEffort: request.reasoningEffort || DEFAULT_CHAT_SETTINGS.reasoningEffort,
	};
}

const rpc = defineElectrobunRPC<ChatRPCSchema>("bun", {
	handlers: {
		requests: {
			getDefaults: () => DEFAULT_CHAT_SETTINGS,
			getAuthState: async () => {
				if (E2E_MODE) {
					return { connected: true, accountId: "e2e" };
				}
				return toAuthState(await refreshAndGetApiKey());
			},
			loginChatGPT: async () => {
				if (E2E_MODE) {
					return {
						connected: true,
						accountId: "e2e",
						message: "E2E auth skipped.",
					};
				}
				let authUrl: string | undefined;
				try {
					await ensureOAuthCallbackPortAvailable();
					const credentials = await loginOpenAICodex({
						onAuth: ({ url }) => {
							authUrl = url;
							Bun.open(url).catch(() => {
								// Browser launch is best-effort; users can manually copy the link if needed.
							});
						},
						onPrompt: async (prompt) => {
							throw new Error(prompt.message);
						},
					});

					await saveProviderCredentials(credentials);
					const result = await refreshAndGetApiKey();
					return {
						...toAuthState(result),
						message: "Login completed.",
						authUrl,
					};
				} catch (error) {
					const message =
						error instanceof Error
							? error.message
							: "ChatGPT login failed. Try again.";
					return {
						connected: false,
						message,
						authUrl,
					};
				}
			},
			sendPrompt: async (payload) => {
				const resolved = resolveSendDefaults(payload);
				if (E2E_MODE) {
					return {
						message: createE2EMessage(
							resolved.provider,
							resolved.model,
						),
					};
				}

				const auth = await refreshAndGetApiKey();
				if (!auth) {
					throw new Error("No active ChatGPT OAuth session. Please log in first.");
				}

				const model = getModel(resolved.provider as never, resolved.model as never);
				const context = { messages: payload.messages };
				const reasoning = resolved.reasoningEffort === "off" ? undefined : resolved.reasoningEffort;

				const response = await completeSimple(model, context, {
					apiKey: auth.apiKey,
					reasoning,
				});

				if (response.stopReason === "error") {
					throw new Error(response.errorMessage || "Chat request failed.");
				}

				const result: SendPromptResponse = {
					message: response,
				};
				return result;
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

const url = await getMainViewUrl();

const mainWindow = new BrowserWindow({
	title: "Electrobun Chat",
	url,
	frame: {
		width: 960,
		height: 760,
		x: 200,
		y: 200,
	},
	rpc,
});

console.log("Svelte + Pi Chat app started!");
