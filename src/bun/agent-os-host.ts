import { AgentOs } from "@rivet-dev/agent-os-core";
import type {
	CreateSessionOptions,
	JsonRpcNotification,
	JsonRpcResponse,
	PermissionReply,
	PermissionRequest,
} from "@rivet-dev/agent-os-core";
import common from "@rivet-dev/agent-os-common";
import pi from "@rivet-dev/agent-os-pi";
import type {
	AssistantMessage,
	AssistantMessageEvent,
	Message,
} from "@mariozechner/pi-ai";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import { getProviderEnvVar, resolveApiKey } from "./auth-store";

let vm: AgentOs | null = null;

const ZERO_USAGE: AssistantMessage["usage"] = {
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

interface ManagedSession {
	sessionId: string;
	provider: string;
	model: string;
	thinkingLevel: ThinkingLevel;
	systemPrompt?: string;
	syncedMessages: Message[];
	lastEventSequence: number;
	needsFullReseed: boolean;
	recreateOnNextPrompt: boolean;
	activePrompt: boolean;
	mutationVersion: number;
}

interface SendAgentPromptOptions {
	sessionId?: string;
	systemPrompt?: string;
	messages: Message[];
	provider: string;
	model: string;
	thinkingLevel: ThinkingLevel;
	onEvent: (event: AssistantMessageEvent) => void;
	onPermissionRequest?: (request: PermissionRequest) => void;
}

interface StreamState {
	partial: AssistantMessage;
	textIndex: number | null;
	thinkingIndex: number | null;
	textEnded: boolean;
	thinkingEnded: boolean;
}

const sessions = new Map<string, ManagedSession>();

export async function initVm(): Promise<void> {
	if (vm) return;
	vm = await AgentOs.create({ software: [common, pi] });
}

export async function disposeVm(): Promise<void> {
	if (!vm) return;

	for (const sessionId of [...sessions.keys()]) {
		try {
			await vm.destroySession(sessionId);
		} catch {
			// Ignore best-effort cleanup failures.
		}
	}

	sessions.clear();
	await vm.dispose();
	vm = null;
}

export async function sendAgentPrompt(
	options: SendAgentPromptOptions,
): Promise<{ sessionId: string }> {
	const session = await ensureSession(options);
	const promptMutationVersion = session.mutationVersion;
	session.activePrompt = true;

	setTimeout(() => {
		void runAgentPrompt(session.sessionId, promptMutationVersion, options);
	}, 0);

	return { sessionId: session.sessionId };
}

export async function destroyAgentSession(sessionId: string): Promise<void> {
	if (!vm) return;
	sessions.delete(sessionId);
	await vm.destroySession(sessionId);
}

export async function cancelAgentSession(sessionId: string): Promise<void> {
	if (!vm || !sessions.has(sessionId)) return;
	await vm.cancelSession(sessionId);
}

export async function respondPermission(
	sessionId: string,
	permissionId: string,
	reply: PermissionReply,
): Promise<void> {
	if (!vm || !sessions.has(sessionId)) return;
	await vm.respondPermission(sessionId, permissionId, reply);
}

export async function setSessionModel(
	sessionId: string,
	model: string,
): Promise<{ ok: boolean; sessionId: string }> {
	const session = sessions.get(sessionId);
	if (!session) {
		return { ok: false, sessionId };
	}

	session.model = model;
	session.needsFullReseed = true;
	session.mutationVersion += 1;

	if (session.activePrompt) {
		session.recreateOnNextPrompt = true;
		return { ok: true, sessionId };
	}

	if (await applyModel(sessionId, model)) {
		session.needsFullReseed = false;
		session.recreateOnNextPrompt = false;
		return { ok: true, sessionId };
	}

	const replacement = await recreateSession(session, { model });
	return { ok: true, sessionId: replacement.sessionId };
}

export async function setSessionThoughtLevel(
	sessionId: string,
	level: ThinkingLevel,
): Promise<{ ok: boolean; sessionId: string }> {
	const session = sessions.get(sessionId);
	if (!session) {
		return { ok: false, sessionId };
	}

	session.thinkingLevel = level;
	session.mutationVersion += 1;

	if (session.activePrompt) {
		session.needsFullReseed = true;
		session.recreateOnNextPrompt = true;
		return { ok: true, sessionId };
	}

	if (await applyThinkingLevel(sessionId, level)) {
		return { ok: true, sessionId };
	}

	session.needsFullReseed = true;

	const replacement = await recreateSession(session, { thinkingLevel: level });
	return { ok: true, sessionId: replacement.sessionId };
}

function buildEnv(provider: string): Record<string, string> {
	const env: Record<string, string> = {};
	const apiKey = resolveApiKey(provider);
	const envVar = getProviderEnvVar(provider);
	if (apiKey && envVar) {
		env[envVar] = apiKey;
	}
	return env;
}

async function ensureSession(
	options: SendAgentPromptOptions,
): Promise<ManagedSession> {
	let session = options.sessionId ? sessions.get(options.sessionId) : undefined;
	if (!session) {
		return createManagedSession(
			options.provider,
			options.model,
			options.thinkingLevel,
			options.systemPrompt,
		);
	}

	if (session.activePrompt) {
		throw new Error(`Session ${session.sessionId} is already streaming.`);
	}

	if (
		session.provider !== options.provider ||
		session.model !== options.model ||
		session.recreateOnNextPrompt
	) {
		session = await recreateSession(session, {
			provider: options.provider,
			model: options.model,
			thinkingLevel: options.thinkingLevel,
			systemPrompt: options.systemPrompt,
		});
	}

	if (
		session.thinkingLevel !== options.thinkingLevel &&
		!(await applyThinkingLevel(session.sessionId, options.thinkingLevel))
	) {
		session = await recreateSession(session, {
			thinkingLevel: options.thinkingLevel,
			systemPrompt: options.systemPrompt,
		});
	}

	session.thinkingLevel = options.thinkingLevel;

	if (session.systemPrompt !== options.systemPrompt) {
		session.systemPrompt = options.systemPrompt;
		if (session.syncedMessages.length > 0) {
			session.needsFullReseed = true;
		}
	}

	if (!canAppendLatestUserTurn(session.syncedMessages, options.messages)) {
		session.needsFullReseed = true;
	}

	return session;
}

async function createManagedSession(
	provider: string,
	model: string,
	thinkingLevel: ThinkingLevel,
	systemPrompt?: string,
): Promise<ManagedSession> {
	const agentVm = await requireVm();
	const createOptions: CreateSessionOptions = {
		env: buildEnv(provider),
	};
	const { sessionId } = await agentVm.createSession("pi", createOptions);

	const session: ManagedSession = {
		sessionId,
		provider,
		model,
		thinkingLevel,
		systemPrompt,
		syncedMessages: [],
		lastEventSequence: getLatestSequenceNumber(sessionId),
		needsFullReseed: false,
		recreateOnNextPrompt: false,
		activePrompt: false,
		mutationVersion: 0,
	};

	sessions.set(sessionId, session);
	await applyModel(sessionId, model);
	await applyThinkingLevel(sessionId, thinkingLevel);
	return session;
}

async function recreateSession(
	session: ManagedSession,
	overrides: Partial<Pick<ManagedSession, "provider" | "model" | "thinkingLevel" | "systemPrompt">>,
): Promise<ManagedSession> {
	const nextProvider = overrides.provider ?? session.provider;
	const nextModel = overrides.model ?? session.model;
	const nextThinkingLevel = overrides.thinkingLevel ?? session.thinkingLevel;
	const nextSystemPrompt = overrides.systemPrompt ?? session.systemPrompt;

	await destroyAgentSession(session.sessionId);

	const replacement = await createManagedSession(
		nextProvider,
		nextModel,
		nextThinkingLevel,
		nextSystemPrompt,
	);
	replacement.needsFullReseed = true;
	return replacement;
}

async function runAgentPrompt(
	sessionId: string,
	promptMutationVersion: number,
	options: SendAgentPromptOptions,
): Promise<void> {
	const agentVm = await requireVm();
	const session = sessions.get(sessionId);
	if (!session) return;

	const promptText = buildPromptText(session, options.messages, options.systemPrompt);
	if (!promptText) {
		session.activePrompt = false;
		options.onEvent({
			type: "error",
			reason: "error",
			error: createErrorMessage(
				options.provider,
				options.model,
				"No user message to send.",
				"error",
			),
		});
		return;
	}

	const streamState = createStreamState(options.provider, options.model);
	const emit = (event: AssistantMessageEvent) => {
		options.onEvent(event);
	};

	emit({ type: "start", partial: streamState.partial });
	replayMissedSessionEvents(session, streamState, emit);

	const unsubscribeEvents = agentVm.onSessionEvent(
		session.sessionId,
		(notification) => emitSessionUpdate(streamState, notification, emit),
	);
	const unsubscribePermissions = options.onPermissionRequest
		? agentVm.onPermissionRequest(session.sessionId, (request) => {
				options.onPermissionRequest?.(request);
			})
		: () => {};

	let finalMessage: AssistantMessage | null = null;

	try {
		const response = await agentVm.prompt(session.sessionId, promptText);
		finalMessage = completePrompt(streamState, options.provider, options.model, response, emit);
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "Agent OS prompt failed.";
		finalMessage = failPrompt(
			streamState,
			options.provider,
			options.model,
			message,
			"error",
			emit,
		);
	} finally {
		unsubscribePermissions();
		unsubscribeEvents();
		session.lastEventSequence = getLatestSequenceNumber(session.sessionId);
		session.activePrompt = false;
	}

	if (!finalMessage) {
		return;
	}

	session.syncedMessages = cloneMessages([...options.messages, finalMessage]);
	session.provider = options.provider;
	session.model = options.model;
	session.thinkingLevel = options.thinkingLevel;
	session.systemPrompt = options.systemPrompt;
	if (session.mutationVersion === promptMutationVersion) {
		session.needsFullReseed = false;
		session.recreateOnNextPrompt = false;
	}
}

function replayMissedSessionEvents(
	session: ManagedSession,
	streamState: StreamState,
	emit: (event: AssistantMessageEvent) => void,
): void {
	const agentVm = vm;
	if (!agentVm) return;

	const replay = agentVm.getSessionEvents(session.sessionId, {
		since: session.lastEventSequence,
	});
	for (const event of replay) {
		emitSessionUpdate(streamState, event.notification, emit);
		session.lastEventSequence = event.sequenceNumber;
	}
}

function emitSessionUpdate(
	streamState: StreamState,
	notification: JsonRpcNotification,
	emit: (event: AssistantMessageEvent) => void,
): void {
	const update = getSessionUpdate(notification);
	if (!update) return;

	const sessionUpdate = getString(update, "sessionUpdate");
	if (sessionUpdate === "agent_message_chunk") {
		const delta = getUpdateText(update);
		if (delta) {
			appendTextDelta(streamState, delta, emit);
		}
		return;
	}

	if (sessionUpdate === "agent_thought_chunk") {
		const delta = getUpdateText(update);
		if (delta) {
			appendThinkingDelta(streamState, delta, emit);
		}
	}
}

function createStreamState(provider: string, model: string): StreamState {
	return {
		partial: createAssistantMessage(provider, model),
		textIndex: null,
		thinkingIndex: null,
		textEnded: false,
		thinkingEnded: false,
	};
}

function appendTextDelta(
	streamState: StreamState,
	delta: string,
	emit: (event: AssistantMessageEvent) => void,
): void {
	if (streamState.textIndex === null) {
		streamState.textIndex = streamState.partial.content.length;
		streamState.partial.content.push({ type: "text", text: "" });
		emit({
			type: "text_start",
			contentIndex: streamState.textIndex,
			partial: streamState.partial,
		});
	}

	const block = streamState.partial.content[streamState.textIndex];
	if (!block || block.type !== "text") return;

	block.text += delta;
	emit({
		type: "text_delta",
		contentIndex: streamState.textIndex,
		delta,
		partial: streamState.partial,
	});
}

function appendThinkingDelta(
	streamState: StreamState,
	delta: string,
	emit: (event: AssistantMessageEvent) => void,
): void {
	if (streamState.thinkingIndex === null) {
		streamState.thinkingIndex = streamState.partial.content.length;
		streamState.partial.content.push({ type: "thinking", thinking: "" });
		emit({
			type: "thinking_start",
			contentIndex: streamState.thinkingIndex,
			partial: streamState.partial,
		});
	}

	const block = streamState.partial.content[streamState.thinkingIndex];
	if (!block || block.type !== "thinking") return;

	block.thinking += delta;
	emit({
		type: "thinking_delta",
		contentIndex: streamState.thinkingIndex,
		delta,
		partial: streamState.partial,
	});
}

function finishOpenBlocks(
	streamState: StreamState,
	emit: (event: AssistantMessageEvent) => void,
): void {
	if (streamState.thinkingIndex !== null && !streamState.thinkingEnded) {
		const block = streamState.partial.content[streamState.thinkingIndex];
		if (block && block.type === "thinking") {
			streamState.thinkingEnded = true;
			emit({
				type: "thinking_end",
				contentIndex: streamState.thinkingIndex,
				content: block.thinking,
				partial: streamState.partial,
			});
		}
	}

	if (streamState.textIndex !== null && !streamState.textEnded) {
		const block = streamState.partial.content[streamState.textIndex];
		if (block && block.type === "text") {
			streamState.textEnded = true;
			emit({
				type: "text_end",
				contentIndex: streamState.textIndex,
				content: block.text,
				partial: streamState.partial,
			});
		}
	}
}

function completePrompt(
	streamState: StreamState,
	provider: string,
	model: string,
	response: JsonRpcResponse,
	emit: (event: AssistantMessageEvent) => void,
): AssistantMessage {
	const errorMessage = getJsonRpcError(response);
	if (errorMessage) {
		return failPrompt(
			streamState,
			provider,
			model,
			errorMessage,
			"error",
			emit,
		);
	}

	if (getPromptStopReason(response) === "cancelled") {
		return failPrompt(
			streamState,
			provider,
			model,
			"Request aborted by user.",
			"aborted",
			emit,
		);
	}

	finishOpenBlocks(streamState, emit);
	const message = finalizeAssistantMessage(streamState.partial, "stop");

	emit({
		type: "done",
		reason: "stop",
		message,
	});

	return message;
}

function failPrompt(
	streamState: StreamState,
	provider: string,
	model: string,
	message: string,
	reason: "aborted" | "error",
	emit: (event: AssistantMessageEvent) => void,
): AssistantMessage {
	finishOpenBlocks(streamState, emit);

	const failure =
		streamState.partial.content.length > 0
			? finalizeAssistantMessage(streamState.partial, reason, message)
			: createErrorMessage(provider, model, message, reason);

	emit({
		type: "error",
		reason,
		error: failure,
	});

	return failure;
}

function buildPromptText(
	session: ManagedSession,
	messages: Message[],
	systemPrompt?: string,
): string {
	if (
		session.needsFullReseed ||
		session.syncedMessages.length === 0 ||
		!canAppendLatestUserTurn(session.syncedMessages, messages)
	) {
		return buildTranscript(systemPrompt, messages);
	}

	const nextMessage = messages[session.syncedMessages.length];
	if (!nextMessage || nextMessage.role !== "user") {
		return buildTranscript(systemPrompt, messages);
	}

	return messageToPlainText(nextMessage);
}

function buildTranscript(systemPrompt: string | undefined, messages: Message[]): string {
	const parts: string[] = [];
	const prompt = systemPrompt?.trim();
	if (prompt) {
		parts.push("System:");
		parts.push(prompt);
		parts.push("");
	}

	for (const message of messages) {
		const text = messageToPlainText(message).trim();
		if (!text) continue;

		const label =
			message.role === "user"
				? "User"
				: message.role === "assistant"
					? "Assistant"
					: `Tool Result (${message.toolName})`;
		parts.push(`${label}:`);
		parts.push(text);
		parts.push("");
	}

	parts.push(
		"Continue the conversation from the latest user message. Respond only as the assistant.",
	);
	return parts.join("\n").trim();
}

function canAppendLatestUserTurn(
	previousMessages: Message[],
	currentMessages: Message[],
): boolean {
	if (previousMessages.length >= currentMessages.length) {
		return false;
	}

	for (let index = 0; index < previousMessages.length; index += 1) {
		if (!messagesEqual(previousMessages[index], currentMessages[index])) {
			return false;
		}
	}

	return currentMessages.at(-1)?.role === "user";
}

function messagesEqual(left: Message, right: Message): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function cloneMessages(messages: Message[]): Message[] {
	return structuredClone(messages);
}

function messageToPlainText(message: Message): string {
	switch (message.role) {
		case "user":
			return flattenUserContent(message.content);
		case "assistant":
			return message.content
				.map((block) => {
					if (block.type === "text") return block.text;
					if (block.type === "toolCall") return `[tool call: ${block.name}]`;
					return "";
				})
				.filter(Boolean)
				.join("\n");
		case "toolResult":
			return message.content
				.map((block) => {
					if (block.type === "text") return block.text;
					if (block.type === "image") return "[image]";
					return "";
				})
				.filter(Boolean)
				.join("\n");
	}
}

function flattenUserContent(content: Message["content"]): string {
	if (typeof content === "string") {
		return content;
	}

	return content
		.map((block) => {
			if (block.type === "text") return block.text;
			if (block.type === "image") return "[image]";
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

function createAssistantMessage(provider: string, model: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: `${provider}-responses`,
		provider,
		model,
		usage: {
			...ZERO_USAGE,
			cost: { ...ZERO_USAGE.cost },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function createErrorMessage(
	provider: string,
	model: string,
	message: string,
	stopReason: "aborted" | "error",
): AssistantMessage {
	const error = createAssistantMessage(provider, model);
	error.content = [{ type: "text", text: message }];
	error.stopReason = stopReason;
	error.errorMessage = message;
	return error;
}

function finalizeAssistantMessage(
	partial: AssistantMessage,
	stopReason: AssistantMessage["stopReason"],
	errorMessage?: string,
): AssistantMessage {
	const message = structuredClone(partial);
	message.stopReason = stopReason;
	message.errorMessage = errorMessage;
	message.timestamp = Date.now();
	return message;
}

function getSessionUpdate(
	notification: JsonRpcNotification,
): Record<string, unknown> | null {
	if (notification.method !== "session/update") {
		return null;
	}

	if (!isRecord(notification.params)) {
		return null;
	}

	const update = notification.params.update;
	return isRecord(update) ? update : null;
}

function getUpdateText(update: Record<string, unknown>): string {
	const content = update.content;
	if (!isRecord(content)) {
		return "";
	}

	if (getString(content, "type") !== "text") {
		return "";
	}

	return getString(content, "text") ?? "";
}

function getLatestSequenceNumber(sessionId: string): number {
	const agentVm = vm;
	if (!agentVm) return -1;

	const events = agentVm.getSessionEvents(sessionId);
	const latest = events.at(-1);
	return latest ? latest.sequenceNumber : -1;
}

function getPromptStopReason(response: JsonRpcResponse): string {
	if (!isRecord(response.result)) {
		return "";
	}

	return getString(response.result, "stopReason") ?? "";
}

function getJsonRpcError(response: JsonRpcResponse | undefined): string | null {
	if (!response?.error) {
		return null;
	}

	return response.error.message || "Agent OS request failed.";
}

async function applyThinkingLevel(
	sessionId: string,
	thinkingLevel: ThinkingLevel,
): Promise<boolean> {
	const agentVm = vm;
	if (!agentVm) return false;

	const typedResponse = await agentVm.setSessionThoughtLevel(
		sessionId,
		thinkingLevel,
	);
	if (!getJsonRpcError(typedResponse)) {
		return true;
	}

	const modeResponse = await agentVm.setSessionMode(sessionId, thinkingLevel);
	return !getJsonRpcError(modeResponse);
}

async function applyModel(sessionId: string, model: string): Promise<boolean> {
	const agentVm = vm;
	if (!agentVm) return false;

	const response = await agentVm.setSessionModel(sessionId, model);
	return !getJsonRpcError(response);
}

async function requireVm(): Promise<AgentOs> {
	if (!vm) {
		await initVm();
	}

	if (!vm) {
		throw new Error("Agent OS VM not initialized.");
	}

	return vm;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function getString(
	record: Record<string, unknown>,
	key: string,
): string | undefined {
	const value = record[key];
	return typeof value === "string" ? value : undefined;
}
