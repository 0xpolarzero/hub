import type { ChatDefaults, ReasoningEffort } from "./chat-settings";
import type { Message, AssistantMessage } from "@mariozechner/pi-ai";

export interface SendPromptRequest {
	messages: Message[];
	provider?: string;
	model?: string;
	reasoningEffort?: ReasoningEffort;
}

export interface SendPromptResponse {
	message: AssistantMessage;
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
		messages: Record<string, never>;
	};
	webview: {
		requests: Record<string, never>;
		messages: Record<string, never>;
	};
}
