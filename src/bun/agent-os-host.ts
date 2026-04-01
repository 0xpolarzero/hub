import { AgentOs } from "@rivet-dev/agent-os-core";
import type { JsonRpcNotification, PermissionRequestHandler, SessionEventHandler } from "@rivet-dev/agent-os-core";
import common from "@rivet-dev/agent-os-common";
import pi from "@rivet-dev/agent-os-pi";
import { resolveApiKey, getProviderEnvVar } from "./auth-store";
import type { AssistantMessageEvent, AssistantMessage } from "@mariozechner/pi-ai";

let vm: AgentOs | null = null;

const ZERO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function makeAssistantMessage(text: string, provider: string, model: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: `${provider}-responses`,
		provider,
		model,
		timestamp: Date.now(),
		usage: ZERO_USAGE,
		stopReason: "stop",
	};
}

function makeErrorMessage(error: string, provider: string, model: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: error }],
		api: `${provider}-responses`,
		provider,
		model,
		timestamp: Date.now(),
		usage: ZERO_USAGE,
		stopReason: "error",
		errorMessage: error,
	};
}

function buildEnv(provider: string): Record<string, string> {
	const env: Record<string, string> = {};
	const apiKey = resolveApiKey(provider);
	const envVar = getProviderEnvVar(provider);
	if (apiKey && envVar) env[envVar] = apiKey;
	return env;
}

export async function initVm(): Promise<void> {
	if (vm) return;
	vm = await AgentOs.create({ software: [common, pi] });
}

export async function disposeVm(): Promise<void> {
	if (!vm) return;
	await vm.dispose();
	vm = null;
}

export interface AgentSession {
	sessionId: string;
	streamId: string;
}

export async function createAgentSession(provider: string, _model: string): Promise<AgentSession> {
	if (!vm) await initVm();

	const env = buildEnv(provider);
	const { sessionId } = await vm!.createSession("pi", { env });
	const streamId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

	return { sessionId, streamId };
}

export async function sendAgentPrompt(
	session: AgentSession,
	prompt: string,
	provider: string,
	model: string,
	onEvent: (event: AssistantMessageEvent) => void,
): Promise<void> {
	if (!vm) throw new Error("Agent OS VM not initialized");

	const { sessionId } = session;
	let textBuffer = "";
	const contentIndex = 0;

	onEvent({
		type: "start",
		partial: makeAssistantMessage("", provider, model),
	} as AssistantMessageEvent);

	const handler: SessionEventHandler = (event: JsonRpcNotification) => {
		const params = event.params as Record<string, unknown> | undefined;

		if (event.method === "session/update" || event.method === "update") {
			const text = (params?.text ?? params?.content ?? params?.delta ?? "") as string;
			if (text) {
				onEvent({
					type: "text_delta",
					contentIndex,
					delta: text,
					partial: makeAssistantMessage(textBuffer + text, provider, model),
				} as AssistantMessageEvent);
				textBuffer += text;
			}
		}
	};

	vm!.onSessionEvent(sessionId, handler);

	try {
		await vm!.prompt(sessionId, prompt);

		onEvent({
			type: "text_end",
			contentIndex,
			content: textBuffer,
			partial: makeAssistantMessage(textBuffer, provider, model),
		} as AssistantMessageEvent);

		onEvent({
			type: "done",
			reason: "stop",
			message: makeAssistantMessage(textBuffer, provider, model),
		} as AssistantMessageEvent);
	} catch (error) {
		const msg = error instanceof Error ? error.message : "Agent OS prompt failed";
		onEvent({
			type: "error",
			reason: "error",
			error: makeErrorMessage(msg, provider, model),
		} as AssistantMessageEvent);
	}
}

export async function destroyAgentSession(sessionId: string): Promise<void> {
	if (!vm) return;
	await vm.destroySession(sessionId);
}

export function onPermissionRequest(
	sessionId: string,
	handler: PermissionRequestHandler,
): () => void {
	if (!vm) return () => {};
	return vm.onPermissionRequest(sessionId, handler);
}
