<script lang="ts">
import { onMount } from "svelte";
import { Electroview } from "electrobun/view";
import {
	AppStorage,
	ChatPanel,
	CustomProvidersStore,
	IndexedDBStorageBackend,
	ProviderKeysStore,
	SessionsStore,
	SettingsStore,
		defaultConvertToLlm,
		setAppStorage,
	} from "@mariozechner/pi-web-ui";
	import { Agent, type StreamFn } from "@mariozechner/pi-agent-core";
	import {
		createAssistantMessageEventStream,
		type AssistantMessage,
		type AssistantMessageEvent,
		getModel,
		type Message,
	} from "@mariozechner/pi-ai";
	import type { ChatRPCSchema, SendPromptRequest } from "./chat-rpc";
import { DEFAULT_CHAT_SETTINGS } from "./chat-settings";

	const DEFAULT_RPC_TIMEOUT_MS = 120000;
	const envTimeout = Number(import.meta.env.VITE_ELECTROBUN_RPC_TIMEOUT_MS ?? `${DEFAULT_RPC_TIMEOUT_MS}`);
	const rpcRequestTimeoutMs = Number.isFinite(envTimeout) && envTimeout > 0 ? Math.trunc(envTimeout) : DEFAULT_RPC_TIMEOUT_MS;

	const rpc = Electroview.defineRPC<ChatRPCSchema>({
		handlers: {},
		maxRequestTime: rpcRequestTimeoutMs,
	});
	new Electroview({ rpc });

	type UsageStats = {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		totalTokens: number;
		cost: {
			input: number;
			output: number;
			cacheRead: number;
			cacheWrite: number;
			total: number;
		};
	};

	const ZERO_USAGE: UsageStats = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
		},
	};

	let container: HTMLDivElement | null = null;
	let panel: ChatPanel | null = null;
	let providerAuthMessage: string | null = null;
	let disposed = false;
	const isE2EMode = import.meta.env.VITE_ELECTROBUN_E2E === "1";

	function createFailureMessage(error: unknown, provider: string, model: string): AssistantMessage {
		const message = error instanceof Error ? error.message : "Unable to generate a response.";
		return {
			role: "assistant",
			content: [{ type: "text", text: message }],
			api: `${provider}-responses`,
			provider,
			model,
			timestamp: Date.now(),
			usage: ZERO_USAGE,
			stopReason: "error",
			errorMessage: message,
		};
	}

	const streamFromRpc: StreamFn = async (model, context, options) => {
		const stream = createAssistantMessageEventStream();
		const reasoningEffort =
			(options?.reasoning as SendPromptRequest["reasoningEffort"]) || DEFAULT_CHAT_SETTINGS.reasoningEffort;
		const request: SendPromptRequest = {
			messages: context.messages as Message[],
			provider: model.provider,
			model: model.id,
			reasoningEffort,
		};

		void (async () => {
			try {
				const { streamId } = await rpc.request.sendPrompt(request);

				const handler = (payload: { streamId: string; event: AssistantMessageEvent }) => {
					if (payload.streamId !== streamId) return;
					stream.push(payload.event);
					if (payload.event.type === "done" || payload.event.type === "error") {
						rpc.removeMessageListener("sendStreamEvent" as never, handler as never);
					}
				};
				rpc.addMessageListener("sendStreamEvent" as never, handler as never);
			} catch (error) {
				const fallback = createFailureMessage(
					error,
					request.provider ?? DEFAULT_CHAT_SETTINGS.provider,
					request.model ?? DEFAULT_CHAT_SETTINGS.model,
				);
				stream.push({ type: "error", reason: "error", error: fallback });
			}
		})();

		return stream;
	};

	function initializeStorage() {
		const settings = new SettingsStore();
		const providerKeys = new ProviderKeysStore();
		const sessions = new SessionsStore();
		const customProviders = new CustomProvidersStore();
		const backend = new IndexedDBStorageBackend({
			dbName: "hub-pi-chat",
			version: 2,
			stores: [
				settings.getConfig(),
				providerKeys.getConfig(),
				sessions.getConfig(),
				customProviders.getConfig(),
				SessionsStore.getMetadataConfig(),
			],
		});

		settings.setBackend(backend);
		providerKeys.setBackend(backend);
		sessions.setBackend(backend);
		customProviders.setBackend(backend);

		const storage = new AppStorage(settings, providerKeys, sessions, customProviders, backend);
		setAppStorage(storage);
		return storage;
	}

	async function bootstrap() {
		const storage = initializeStorage();

		try {
			const auth = await rpc.request.getAuthState();
			if (disposed) return;

			const defaults = await rpc.request.getDefaults();

			if (auth.connected || isE2EMode) {
				await storage.providerKeys.set(defaults.provider, "oauth");
			}

			const agent = new Agent({
				initialState: {
					systemPrompt: "You are a helpful AI assistant.",
					model: getModel(defaults.provider, defaults.model),
					thinkingLevel: defaults.reasoningEffort,
					messages: [],
					tools: [],
				},
				convertToLlm: defaultConvertToLlm,
				streamFn: streamFromRpc,
			});

			const chatPanel = new ChatPanel();
			await chatPanel.setAgent(agent, {
				onApiKeyRequired: async (provider) => {
					const loginState = await rpc.request.loginChatGPT();
					if (!loginState.connected) return false;
					await storage.providerKeys.set(provider, loginState.accountId || "oauth");
					return true;
				},
			});

			if (!container || disposed) {
				return;
			}

			container.innerHTML = "";
			container.append(chatPanel);
			panel = chatPanel;
			providerAuthMessage = null;
		} catch (error) {
			if (!disposed) {
				providerAuthMessage = error instanceof Error ? error.message : "Unable to initialize chat.";
			}
		}
	}

	onMount(() => {
		void bootstrap();
		return () => {
			disposed = true;
			if (container) {
				container.innerHTML = "";
			}
			if (panel) {
				panel.remove();
				panel = null;
			}
		};
	});

</script>

<div bind:this={container} class="h-screen w-full">
	{#if providerAuthMessage}
		<div class="auth-error">{providerAuthMessage}</div>
	{/if}
	{#if !panel && !providerAuthMessage}
		<div class="auth-error">Initializing chat…</div>
	{/if}
</div>

<style>
	.auth-error {
		padding: 0.75rem;
		font-size: 0.875rem;
		color: #b91c1c;
	}
</style>
