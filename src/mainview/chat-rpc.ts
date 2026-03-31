import type { ChatDefaults, ReasoningEffort } from "./chat-settings";
import type { Message, AssistantMessageEvent } from "@mariozechner/pi-ai";

export type AuthKeyType = "apikey" | "oauth" | "env" | "none";

export interface SendPromptRequest {
	messages: Message[];
	provider?: string;
	model?: string;
	reasoningEffort?: ReasoningEffort;
}

export interface SendPromptResponse {
	streamId: string;
}

export interface StreamEventMessage {
	streamId: string;
	event: AssistantMessageEvent;
}

export interface AuthStateResponse {
	connected: boolean;
	accountId?: string;
	message?: string;
	authUrl?: string;
}

export interface ProviderAuthInfo {
	provider: string;
	hasKey: boolean;
	keyType: AuthKeyType;
	supportsOAuth: boolean;
}

export interface ChatRPCSchema {
	bun: {
		requests: {
			getDefaults: {
				response: ChatDefaults;
			};
			getAuthState: {
				response: AuthStateResponse;
			};
			loginChatGPT: {
				response: AuthStateResponse;
			};
			sendPrompt: {
				params: SendPromptRequest;
				response: SendPromptResponse;
			};
			listProviderAuths: {
				response: ProviderAuthInfo[];
			};
			setProviderApiKey: {
				params: { providerId: string; apiKey: string };
				response: { ok: boolean };
			};
			startOAuth: {
				params: { providerId: string };
				response: { ok: boolean; error?: string };
			};
			removeProviderAuth: {
				params: { providerId: string };
				response: { ok: boolean };
			};
		};
		messages: {
			sendStreamEvent: StreamEventMessage;
		};
	};
	webview: {
		requests: Record<string, never>;
		messages: Record<string, never>;
	};
}
