<script lang="ts">
	import { onMount } from "svelte";
	import {
		AppStorage,
		ChatPanel,
		CustomProvidersStore,
		IndexedDBStorageBackend,
		ModelSelector,
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
		import type { SendPromptRequest } from "./chat-rpc";
	import { DEFAULT_CHAT_SETTINGS } from "./chat-settings";
	import Settings from "./Settings.svelte";
	import { rpc } from "./rpc";

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
	let showSettings = $state(false);
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
						rpc.removeMessageListener("sendStreamEvent", handler);
					}
				};
				rpc.addMessageListener("sendStreamEvent", handler);
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
				onModelSelect: async () => {
					const auths = await rpc.request.listProviderAuths();
					const allowed = auths.filter((a) => a.hasKey).map((a) => a.provider);
					ModelSelector.open(agent.state.model, (model) => agent.setModel(model), allowed);
				},
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

<div class="app-container">
	<div class="toolbar">
		<div class="spacer"></div>
		<button class="settings-btn" onclick={() => showSettings = true} title="Settings">
			<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
				<circle cx="12" cy="12" r="3"/>
				<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
			</svg>
		</button>
	</div>
	<div bind:this={container} class="chat-area">
		{#if providerAuthMessage}
			<div class="auth-error">{providerAuthMessage}</div>
		{/if}
		{#if !panel && !providerAuthMessage}
			<div class="auth-error">Initializing chat...</div>
		{/if}
	</div>
</div>

{#if showSettings}
	<Settings onClose={() => showSettings = false} />
{/if}

<style>
	.app-container {
		display: flex;
		flex-direction: column;
		height: 100vh;
		width: 100%;
	}

	.toolbar {
		display: flex;
		align-items: center;
		padding: 4px 8px;
		border-bottom: 1px solid #e5e7eb;
		flex-shrink: 0;
	}

	.spacer { flex: 1; }

	.settings-btn {
		background: none;
		border: none;
		cursor: pointer;
		padding: 6px;
		border-radius: 6px;
		color: #6b7280;
		display: flex;
		align-items: center;
	}

	.settings-btn:hover {
		background: #f3f4f6;
		color: #374151;
	}

	.chat-area {
		flex: 1;
		min-height: 0;
	}

	.auth-error {
		padding: 0.75rem;
		font-size: 0.875rem;
		color: #b91c1c;
	}
</style>
