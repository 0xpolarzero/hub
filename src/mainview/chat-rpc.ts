import type { ChatDefaults, ReasoningEffort } from "./chat-settings";
import type { Message, AssistantMessageEvent } from "@mariozechner/pi-ai";

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
