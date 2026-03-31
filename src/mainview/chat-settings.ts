import type { ThinkingLevel } from "@mariozechner/pi-agent-core";

export type ReasoningEffort = ThinkingLevel;

export interface ChatDefaults {
	provider: string;
	model: string;
	reasoningEffort: ReasoningEffort;
}

export const DEFAULT_CHAT_SETTINGS: ChatDefaults = {
	provider: "zai",
	model: "glm-4.5",
	reasoningEffort: "medium",
};
