<script lang="ts">
	import { onMount } from "svelte";
	import type { ProviderAuthInfo } from "./chat-rpc";
	import { rpc } from "./rpc";

	type Props = { onClose: () => void };
	let { onClose }: Props = $props();

	let providers = $state<ProviderAuthInfo[]>([]);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let editingProvider = $state<string | null>(null);
	let apiKeyInput = $state<Record<string, string>>({});
	let oauthLoading = $state<Record<string, boolean>>({});
	let saveMessage = $state<Record<string, string>>({});

	async function refreshProviders() {
		try {
			providers = await rpc.request.listProviderAuths();
		} catch (err) {
			error = err instanceof Error ? err.message : "Failed to load providers";
		}
	}

	onMount(async () => {
		await refreshProviders();
		loading = false;
	});

	async function handleSaveApiKey(providerId: string) {
		const key = apiKeyInput[providerId]?.trim();
		if (!key) return;
		try {
			await rpc.request.setProviderApiKey({ providerId, apiKey: key });
			apiKeyInput[providerId] = "";
			editingProvider = null;
			saveMessage[providerId] = "Saved";
			await refreshProviders();
			setTimeout(() => { saveMessage[providerId] = ""; }, 2000);
		} catch (err) {
			saveMessage[providerId] = err instanceof Error ? err.message : "Failed";
		}
	}

	async function handleOAuth(providerId: string) {
		oauthLoading[providerId] = true;
		saveMessage[providerId] = "";
		try {
			const result = await rpc.request.startOAuth({ providerId });
			if (result.ok) {
				saveMessage[providerId] = "Connected";
				await refreshProviders();
			} else {
				saveMessage[providerId] = result.error ?? "OAuth failed";
			}
		} catch (err) {
			saveMessage[providerId] = err instanceof Error ? err.message : "OAuth failed";
		} finally {
			oauthLoading[providerId] = false;
			setTimeout(() => { saveMessage[providerId] = ""; }, 3000);
		}
	}

	async function handleRemove(providerId: string) {
		await rpc.request.removeProviderAuth({ providerId });
		saveMessage[providerId] = "Removed";
		await refreshProviders();
		setTimeout(() => { saveMessage[providerId] = ""; }, 2000);
	}

	function statusBadge(info: ProviderAuthInfo) {
		if (!info.hasKey) return { text: "Not configured", cls: "badge-none" };
		if (info.keyType === "oauth") return { text: "OAuth", cls: "badge-oauth" };
		if (info.keyType === "env") return { text: "Env var", cls: "badge-env" };
		return { text: "API key", cls: "badge-key" };
	}
</script>

<div class="settings-overlay" onclick={onClose}>
	<div class="settings-panel" onclick={(e) => e.stopPropagation()}>
		<div class="settings-header">
			<h2>Settings</h2>
			<button class="close-btn" onclick={onClose}>&times;</button>
		</div>

		<div class="settings-body">
			{#if loading}
				<p class="loading">Loading providers...</p>
			{:else if error}
				<p class="error">{error}</p>
			{:else}
				<p class="hint">Configure API keys or use OAuth to connect AI providers. Keys are stored locally at <code>~/.config/acai/auth.json</code>.</p>
				<div class="provider-list">
					{#each providers as info (info.provider)}
						{@const badge = statusBadge(info)}
						{@const isEditing = editingProvider === info.provider}
						<div class="provider-row">
							<div class="provider-info">
								<span class="provider-name">{info.provider}</span>
								<span class="badge {badge.cls}">{badge.text}</span>
								{#if saveMessage[info.provider]}
									<span class="save-msg">{saveMessage[info.provider]}</span>
								{/if}
							</div>
							<div class="provider-actions">
								{#if isEditing}
									<div class="key-input-row">
										<input
											type="password"
											placeholder="Paste API key..."
											bind:value={apiKeyInput[info.provider]}
											onkeydown={(e) => e.key === "Enter" && handleSaveApiKey(info.provider)}
										/>
										<button class="btn btn-primary" onclick={() => handleSaveApiKey(info.provider)}>Save</button>
										<button class="btn" onclick={() => { editingProvider = null; apiKeyInput[info.provider] = ""; }}>Cancel</button>
									</div>
								{:else}
									{#if info.hasKey}
										<button class="btn btn-sm" onclick={() => handleRemove(info.provider)}>Remove</button>
									{/if}
									<button class="btn btn-sm" onclick={() => { editingProvider = info.provider; apiKeyInput[info.provider] = ""; }}>Set Key</button>
									{#if info.supportsOAuth}
										<button class="btn btn-sm btn-oauth" disabled={oauthLoading[info.provider]} onclick={() => handleOAuth(info.provider)}>
											{oauthLoading[info.provider] ? "Waiting..." : "Login with OAuth"}
										</button>
									{/if}
								{/if}
							</div>
						</div>
					{/each}
				</div>
			{/if}
		</div>
	</div>
</div>

<style>
	.settings-overlay {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.5);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 1000;
	}

	.settings-panel {
		background: #fff;
		border-radius: 12px;
		width: min(700px, 90vw);
		max-height: 80vh;
		display: flex;
		flex-direction: column;
		box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
	}

	.settings-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 16px 24px;
		border-bottom: 1px solid #e5e7eb;
	}

	.settings-header h2 {
		margin: 0;
		font-size: 18px;
		font-weight: 600;
	}

	.close-btn {
		background: none;
		border: none;
		font-size: 24px;
		cursor: pointer;
		color: #6b7280;
		padding: 0 4px;
		line-height: 1;
	}

	.close-btn:hover { color: #111; }

	.settings-body {
		padding: 16px 24px 24px;
		overflow-y: auto;
		flex: 1;
	}

	.hint {
		font-size: 13px;
		color: #6b7280;
		margin: 0 0 16px;
	}

	.hint code {
		font-size: 12px;
		background: #f3f4f6;
		padding: 2px 6px;
		border-radius: 4px;
	}

	.loading, .error {
		font-size: 14px;
		color: #6b7280;
	}

	.error { color: #b91c1c; }

	.provider-list {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.provider-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 10px 12px;
		border-radius: 8px;
		gap: 12px;
		flex-wrap: wrap;
	}

	.provider-row:hover { background: #f9fafb; }

	.provider-info {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
	}

	.provider-name {
		font-size: 14px;
		font-weight: 500;
		white-space: nowrap;
	}

	.badge {
		font-size: 11px;
		padding: 2px 8px;
		border-radius: 10px;
		font-weight: 500;
		white-space: nowrap;
	}

	.badge-none { background: #f3f4f6; color: #9ca3af; }
	.badge-key { background: #dbeafe; color: #1d4ed8; }
	.badge-oauth { background: #dcfce7; color: #15803d; }
	.badge-env { background: #fef3c7; color: #92400e; }

	.save-msg {
		font-size: 12px;
		color: #16a34a;
		font-weight: 500;
	}

	.provider-actions {
		display: flex;
		align-items: center;
		gap: 6px;
		flex-shrink: 0;
	}

	.key-input-row {
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.key-input-row input {
		font-size: 13px;
		padding: 4px 10px;
		border: 1px solid #d1d5db;
		border-radius: 6px;
		width: 220px;
		outline: none;
	}

	.key-input-row input:focus { border-color: #3b82f6; }

	.btn {
		font-size: 13px;
		padding: 4px 12px;
		border-radius: 6px;
		border: 1px solid #d1d5db;
		background: #fff;
		cursor: pointer;
		white-space: nowrap;
	}

	.btn:hover { background: #f9fafb; }

	.btn-sm { font-size: 12px; padding: 3px 10px; }

	.btn-primary {
		background: #3b82f6;
		color: #fff;
		border-color: #3b82f6;
	}

	.btn-primary:hover { background: #2563eb; }

	.btn-oauth {
		background: #f0fdf4;
		color: #15803d;
		border-color: #bbf7d0;
	}

	.btn-oauth:hover { background: #dcfce7; }

	.btn:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
