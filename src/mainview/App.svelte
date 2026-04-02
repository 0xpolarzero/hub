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
	import type {
		PermissionRequestMessage,
		RespondPermissionRequest,
		SendPromptRequest,
	} from "./chat-rpc";
	import { DEFAULT_CHAT_SETTINGS, type ReasoningEffort } from "./chat-settings";
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
	let agent: Agent | null = null;
	let panel = $state<ChatPanel | null>(null);
	let providerAuthMessage = $state<string | null>(null);
	let permissionRequests = $state<PermissionRequestMessage[]>([]);
	let showSettings = $state(false);
	let disposed = false;
	const isE2EMode = import.meta.env.VITE_ELECTROBUN_E2E === "1";

	function createFailureMessage(
		error: unknown,
		provider: string,
		model: string,
		stopReason: "aborted" | "error" = "error",
	): AssistantMessage {
		const message =
			error instanceof Error
				? error.message
				: "Unable to generate a response.";
		return {
			role: "assistant",
			content: [{ type: "text", text: message }],
			api: `${provider}-responses`,
			provider,
			model,
			timestamp: Date.now(),
			usage: ZERO_USAGE,
			stopReason,
			errorMessage: message,
		};
	}

	async function cancelPrompt(sessionId?: string): Promise<void> {
		if (!sessionId) return;

		try {
			await rpc.request.cancelPrompt({ sessionId });
		} catch (error) {
			console.error("Failed to cancel prompt:", error);
		}
	}

	async function syncSessionModel(modelId: string): Promise<void> {
		const sessionId = agent?.sessionId;
		if (!agent || !sessionId) return;

		try {
			const response = await rpc.request.setSessionModel({
				sessionId,
				model: modelId,
			});
			if (response.ok) {
				agent.sessionId = response.sessionId;
			}
		} catch (error) {
			console.error("Failed to sync session model:", error);
		}
	}

	async function syncSessionThoughtLevel(level: ReasoningEffort): Promise<void> {
		const sessionId = agent?.sessionId;
		if (!agent || !sessionId) return;

		try {
			const response = await rpc.request.setSessionThoughtLevel({
				sessionId,
				level,
			});
			if (response.ok) {
				agent.sessionId = response.sessionId;
			}
		} catch (error) {
			console.error("Failed to sync session thought level:", error);
		}
	}

	function removePermissionRequest(permissionId: string): void {
		permissionRequests = permissionRequests.filter(
			(request) => request.permissionId !== permissionId,
		);
	}

	async function respondToPermission(
		request: PermissionRequestMessage,
		reply: RespondPermissionRequest["reply"],
	): Promise<void> {
		try {
			const response = await rpc.request.respondPermission({
				sessionId: request.sessionId,
				permissionId: request.permissionId,
				reply,
			});
			if (!response.ok) {
				return;
			}
		} catch (error) {
			console.error("Failed to respond to permission request:", error);
			return;
		}

		removePermissionRequest(request.permissionId);
	}

	const streamFromRpc: StreamFn = async (model, context, options) => {
		const stream = createAssistantMessageEventStream();
		const reasoningEffort =
			(options?.reasoning as ReasoningEffort | undefined) ??
			DEFAULT_CHAT_SETTINGS.reasoningEffort;
		const request: SendPromptRequest = {
			messages: context.messages as Message[],
			provider: model.provider,
			model: model.id,
			reasoningEffort,
			sessionId: agent?.sessionId,
			systemPrompt: context.systemPrompt,
		};
		const provider = request.provider ?? DEFAULT_CHAT_SETTINGS.provider;
		const modelId = request.model ?? DEFAULT_CHAT_SETTINGS.model;
		let activeStreamId: string | null = null;
		let activeSessionId = request.sessionId ?? agent?.sessionId;
		let completed = false;

		const cleanup = () => {
			rpc.removeMessageListener("sendStreamEvent", streamListener);
			if (options?.signal) {
				options.signal.removeEventListener("abort", abort);
			}
		};

		const finishWithError = (
			stopReason: "aborted" | "error",
			error: unknown,
		): void => {
			if (completed) return;
			completed = true;
			cleanup();
			stream.push({
				type: "error",
				reason: stopReason,
				error: createFailureMessage(error, provider, modelId, stopReason),
			});
		};

		const streamListener = (payload: {
			streamId: string;
			event: AssistantMessageEvent;
		}) => {
			if (completed || activeStreamId === null) return;
			if (payload.streamId !== activeStreamId) return;

			stream.push(payload.event);
			if (payload.event.type === "done" || payload.event.type === "error") {
				completed = true;
				cleanup();
			}
		};

		const abort = (): void => {
			if (completed) return;
			void cancelPrompt(activeSessionId);
			finishWithError("aborted", new Error("Request aborted by user"));
		};

		rpc.addMessageListener("sendStreamEvent", streamListener);
		if (options?.signal) {
			options.signal.addEventListener("abort", abort, { once: true });
			if (options.signal.aborted) {
				abort();
			}
		}

		void (async () => {
			try {
				const response = await rpc.request.sendPrompt(request);
				activeStreamId = response.streamId;
				activeSessionId = response.sessionId;
				if (agent) {
					agent.sessionId = response.sessionId;
				}

				if (options?.signal?.aborted) {
					abort();
				}
			} catch (error) {
				finishWithError("error", error);
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

		const storage = new AppStorage(
			settings,
			providerKeys,
			sessions,
			customProviders,
			backend,
		);
		setAppStorage(storage);
		return storage;
	}

	async function bootstrap() {
		const storage = initializeStorage();

		try {
			const auth = await rpc.request.getAuthState();
			if (disposed) return;

			const defaults = await rpc.request.getDefaults();
			if (disposed) return;

			if (auth.connected || isE2EMode) {
				await storage.providerKeys.set(defaults.provider, "oauth");
			}
			if (disposed) return;

			agent = new Agent({
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
			if (disposed || !agent) return;

			const originalSetModel = agent.setModel.bind(agent);
			agent.setModel = (nextModel) => {
				originalSetModel(nextModel);
				void syncSessionModel(nextModel.id);
			};

			const originalSetThinkingLevel = agent.setThinkingLevel.bind(agent);
			agent.setThinkingLevel = (level) => {
				originalSetThinkingLevel(level);
				void syncSessionThoughtLevel(level);
			};

			const chatPanel = new ChatPanel();
			const currentAgent = agent;
			await chatPanel.setAgent(currentAgent, {
				onModelSelect: async () => {
					const auths = await rpc.request.listProviderAuths();
					const allowed = auths
						.filter((authInfo) => authInfo.hasKey)
						.map((authInfo) => authInfo.provider);
					ModelSelector.open(
						currentAgent.state.model,
						(modelChoice) => currentAgent.setModel(modelChoice),
						allowed,
					);
				},
				onApiKeyRequired: async (provider) => {
					const loginState = await rpc.request.loginChatGPT();
					if (!loginState.connected) return false;
					await storage.providerKeys.set(
						provider,
						loginState.accountId || "oauth",
					);
					return true;
				},
			});

			if (!container || disposed) return;

			container.innerHTML = "";
			container.append(chatPanel);
			panel = chatPanel;
			providerAuthMessage = null;
		} catch (error) {
			if (!disposed) {
				providerAuthMessage =
					error instanceof Error
						? error.message
						: "Unable to initialize chat.";
			}
		}
	}

	onMount(() => {
		const permissionHandler = (request: PermissionRequestMessage) => {
			permissionRequests = [
				...permissionRequests.filter(
					(entry) => entry.permissionId !== request.permissionId,
				),
				request,
			];
		};

		rpc.addMessageListener("permissionRequest", permissionHandler);
		void bootstrap();

		return () => {
			disposed = true;
			rpc.removeMessageListener("permissionRequest", permissionHandler);
			permissionRequests = [];
			if (container) {
				container.innerHTML = "";
			}
			if (panel) {
				panel.remove();
				panel = null;
			}
			agent = null;
		};
	});
</script>

<div class="app-container">
	<div class="toolbar">
		<div class="spacer"></div>
		<button class="settings-btn" onclick={() => (showSettings = true)} title="Settings">
			<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
				<circle cx="12" cy="12" r="3"></circle>
				<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
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

	{#if permissionRequests.length > 0}
		<div class="permission-stack">
			{#each permissionRequests as request (request.permissionId)}
				<div class="permission-card">
					<div class="permission-title">Permission request</div>
					<div class="permission-description">
						{request.description ||
							"The agent wants to perform an action that needs your approval."}
					</div>
					<pre class="permission-params">{JSON.stringify(request.params, null, 2)}</pre>
					<div class="permission-actions">
						<button onclick={() => void respondToPermission(request, "once")}>Approve once</button>
						<button onclick={() => void respondToPermission(request, "always")}>Always allow</button>
						<button onclick={() => void respondToPermission(request, "reject")}>Reject</button>
					</div>
				</div>
			{/each}
		</div>
	{/if}
</div>

{#if showSettings}
	<Settings onClose={() => (showSettings = false)} />
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

	.spacer {
		flex: 1;
	}

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

	.permission-stack {
		position: fixed;
		top: 3.25rem;
		right: 1rem;
		z-index: 30;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		width: min(28rem, calc(100vw - 2rem));
	}

	.permission-card {
		background: rgba(255, 255, 255, 0.96);
		backdrop-filter: blur(12px);
		border: 1px solid #d1d5db;
		border-radius: 14px;
		padding: 0.9rem 1rem;
		box-shadow: 0 18px 40px rgba(15, 23, 42, 0.12);
	}

	.permission-title {
		font-weight: 600;
		color: #111827;
		margin-bottom: 0.25rem;
	}

	.permission-description {
		font-size: 0.875rem;
		color: #374151;
		margin-bottom: 0.75rem;
	}

	.permission-params {
		margin: 0 0 0.75rem;
		padding: 0.75rem;
		border-radius: 10px;
		background: #f9fafb;
		border: 1px solid #e5e7eb;
		font-size: 0.75rem;
		line-height: 1.4;
		color: #4b5563;
		max-height: 14rem;
		overflow: auto;
		white-space: pre-wrap;
		word-break: break-word;
	}

	.permission-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}

	.permission-actions button {
		border: 1px solid #d1d5db;
		background: white;
		color: #111827;
		border-radius: 999px;
		padding: 0.45rem 0.8rem;
		font-size: 0.8125rem;
		cursor: pointer;
	}

	.permission-actions button:hover {
		background: #f3f4f6;
	}
</style>
