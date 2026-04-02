import type { ChatDefaults, ReasoningEffort } from "./chat-settings";
import type { Message, AssistantMessageEvent } from "@mariozechner/pi-ai";

export type AuthKeyType = "apikey" | "oauth" | "env" | "none";

export interface SendPromptRequest {
	messages: Message[];
	provider?: string;
	model?: string;
	reasoningEffort?: ReasoningEffort;
	sessionId?: string;
	systemPrompt?: string;
}

export interface SendPromptResponse {
	streamId: string;
	sessionId: string;
}

export interface SetSessionModelRequest {
	sessionId: string;
	model: string;
}

export interface SetSessionThoughtLevelRequest {
	sessionId: string;
	level: ReasoningEffort;
}

export interface StreamEventMessage {
	streamId: string;
	event: AssistantMessageEvent;
}

export interface PermissionRequestMessage {
	sessionId: string;
	permissionId: string;
	description?: string;
	params: Record<string, unknown>;
}

export interface RespondPermissionRequest {
	sessionId: string;
	permissionId: string;
	reply: "once" | "always" | "reject";
}

export interface CancelPromptRequest {
	sessionId: string;
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
				params: undefined;
				response: ChatDefaults;
			};
			getAuthState: {
				params: undefined;
				response: AuthStateResponse;
			};
			loginChatGPT: {
				params: undefined;
				response: AuthStateResponse;
			};
			sendPrompt: {
				params: SendPromptRequest;
				response: SendPromptResponse;
			};
			setSessionModel: {
				params: SetSessionModelRequest;
				response: { ok: boolean; sessionId: string };
			};
			setSessionThoughtLevel: {
				params: SetSessionThoughtLevelRequest;
				response: { ok: boolean; sessionId: string };
			};
			cancelPrompt: {
				params: CancelPromptRequest;
				response: { ok: boolean };
			};
			respondPermission: {
				params: RespondPermissionRequest;
				response: { ok: boolean };
			};
			listProviderAuths: {
				params: undefined;
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
		messages: Record<string, never>;
	};
	webview: {
		requests: Record<string, never>;
		messages: {
			sendStreamEvent: StreamEventMessage;
			permissionRequest: PermissionRequestMessage;
		};
	};
}
