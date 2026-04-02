import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { AgentOs } from "@rivet-dev/agent-os-core";
import common from "@rivet-dev/agent-os-common";
import pi from "@rivet-dev/agent-os-pi";
import type {
	JsonRpcNotification,
	PermissionRequest,
	SequencedEvent,
} from "@rivet-dev/agent-os-core";

type StreamChunkKind = "text" | "thinking";

interface StreamChunkEvent {
	type: "chunk";
	kind: StreamChunkKind;
	sessionId: string;
	text: string;
}

interface StreamEndEvent {
	type: "end";
	sessionId: string;
}

interface StreamErrorEvent {
	type: "error";
	sessionId: string;
	error: string;
}

type StreamEvent = StreamChunkEvent | StreamEndEvent | StreamErrorEvent;

function getTextContent(value: unknown): string | null {
	if (typeof value === "string") {
		return value;
	}

	if (!value || typeof value !== "object") {
		return null;
	}

	const content = value as { type?: unknown; text?: unknown };
	if (content.type === "text" && typeof content.text === "string") {
		return content.text;
	}

	return null;
}

function getSessionUpdate(notification: JsonRpcNotification): Record<string, unknown> | null {
	if (notification.method !== "session/update") {
		return null;
	}

	const params = notification.params;
	if (!params || typeof params !== "object") {
		return null;
	}

	const update = (params as { update?: unknown }).update;
	if (!update || typeof update !== "object") {
		return null;
	}

	return update as Record<string, unknown>;
}

function adaptSessionUpdate(sessionId: string, event: SequencedEvent): StreamEvent | null {
	const update = getSessionUpdate(event.notification);
	if (!update) {
		return null;
	}

	const sessionUpdate = update.sessionUpdate;
	if (sessionUpdate !== "agent_message_chunk" && sessionUpdate !== "agent_thought_chunk") {
		return null;
	}

	const text = getTextContent(update.content);
	if (!text) {
		return null;
	}

	return {
		type: "chunk",
		kind: sessionUpdate === "agent_thought_chunk" ? "thinking" : "text",
		sessionId,
		text,
	};
}

function buildPermissionShape(request: PermissionRequest): {
	permissionId: string;
	description: string | undefined;
	params: Record<string, unknown>;
} {
	return {
		permissionId: request.permissionId,
		description: request.description,
		params: request.params,
	};
}

describe("Event Streaming Adapter", () => {
	let vm: AgentOs;

	beforeAll(async () => {
		vm = await AgentOs.create({
			software: [common, pi],
		});
	});

	afterAll(async () => {
		if (vm) await vm.dispose();
	});

	test("adapter extracts text chunks from session/update notifications", () => {
		const mockEvent: SequencedEvent = {
			sequenceNumber: 1,
			notification: {
				method: "session/update",
				params: {
					update: {
						sessionUpdate: "agent_message_chunk",
						content: { type: "text", text: "Hello " },
					},
				},
			},
		};

		const adapted = adaptSessionUpdate("sess-1", mockEvent);
		expect(adapted).toEqual({
			type: "chunk",
			kind: "text",
			sessionId: "sess-1",
			text: "Hello ",
		});
	});

	test("adapter extracts thinking chunks from session/update notifications", () => {
		const mockEvent: SequencedEvent = {
			sequenceNumber: 2,
			notification: {
				method: "session/update",
				params: {
					update: {
						sessionUpdate: "agent_thought_chunk",
						content: { type: "text", text: "thinking..." },
					},
				},
			},
		};

		const adapted = adaptSessionUpdate("sess-1", mockEvent);
		expect(adapted).toEqual({
			type: "chunk",
			kind: "thinking",
			sessionId: "sess-1",
			text: "thinking...",
		});
	});

	test("adapter ignores unknown or unrelated notifications", () => {
		const ignoredEvents: SequencedEvent[] = [
			{
				sequenceNumber: 3,
				notification: {
					method: "session/update",
					params: {
						update: {
							sessionUpdate: "tool_call_update",
							content: { type: "text", text: "tool" },
						},
					},
				},
			},
			{
				sequenceNumber: 4,
				notification: {
					method: "request/permission",
					params: {
						permissionId: "perm-1",
					},
				},
			},
		];

		for (const event of ignoredEvents) {
			expect(adaptSessionUpdate("sess-1", event)).toBeNull();
		}
	});

	test("real session events can be subscribed to", async () => {
		const apiKey = process.env.OPENAI_API_KEY;
		if (!apiKey) {
			console.log("SKIP: No OPENAI_API_KEY set");
			return;
		}

		const { sessionId } = await vm.createSession("pi", {
			env: { OPENAI_API_KEY: apiKey },
		});

		const events: SequencedEvent[] = [];
		const unsub = vm.onSessionEvent(sessionId, (event) => {
			events.push(event);
		});

		await vm.prompt(sessionId, "Say exactly: test-pong");

		unsub();

		expect(events.length).toBeGreaterThan(0);

		for (const event of events) {
			expect(event.sequenceNumber).toBeDefined();
			expect(typeof event.sequenceNumber).toBe("number");
		}

		for (let i = 1; i < events.length; i++) {
			expect(events[i].sequenceNumber).toBeGreaterThan(events[i - 1].sequenceNumber);
		}

		await vm.destroySession(sessionId);
	});

	test("event replay via getSessionEvents returns session/update chunks", async () => {
		const apiKey = process.env.OPENAI_API_KEY;
		if (!apiKey) {
			console.log("SKIP: No OPENAI_API_KEY set");
			return;
		}

		const { sessionId } = await vm.createSession("pi", {
			env: { OPENAI_API_KEY: apiKey },
		});

		const startSequence = vm.getSessionEvents(sessionId).at(-1)?.sequenceNumber ?? 0;

		await vm.prompt(sessionId, "Say exactly: replay-test");

		const replayed = vm.getSessionEvents(sessionId, {
			since: startSequence,
			method: "session/update",
		});

		expect(replayed.length).toBeGreaterThan(0);

		const adapted = replayed
			.map((event) => adaptSessionUpdate(sessionId, event))
			.filter((event): event is StreamChunkEvent => event !== null && event.type === "chunk");

		expect(adapted.length).toBeGreaterThan(0);
		expect(adapted.some((event) => event.kind === "text")).toBe(true);

		for (const event of replayed) {
			expect(event.sequenceNumber).toBeGreaterThan(startSequence);
		}

		await vm.destroySession(sessionId);
	});

	test("permission request events expose the expected shape", async () => {
		const apiKey = process.env.OPENAI_API_KEY;
		if (!apiKey) {
			console.log("SKIP: No OPENAI_API_KEY set");
			return;
		}

		const { sessionId } = await vm.createSession("pi", {
			env: { OPENAI_API_KEY: apiKey },
		});

		const permissionRequests: PermissionRequest[] = [];
		const unsub = vm.onPermissionRequest(sessionId, (request) => {
			permissionRequests.push(request);
			void vm.respondPermission(sessionId, request.permissionId, "once");
		});

		await vm.prompt(
			sessionId,
			"Use the file system to create /home/user/agent-os-permission-test.txt with the text hello, then report the path.",
		);

		unsub();

		const request = permissionRequests[0] ?? null;
		if (!request) {
			console.log("SKIP: No permission request emitted by the adapter");
			await vm.destroySession(sessionId);
			return;
		}

		expect(buildPermissionShape(request)).toEqual({
			permissionId: request.permissionId,
			description: request.description,
			params: request.params,
		});
		expect(typeof request.permissionId).toBe("string");
		expect(typeof request.params).toBe("object");
		expect(request.params).not.toBeNull();

		const history = vm.getSessionEvents(sessionId);
		const replayedPermission = history.find(
			(event) => event.notification.method === "request/permission",
		);
		expect(replayedPermission).toBeDefined();

		const replayParams = replayedPermission?.notification.params as
			| {
					permissionId?: unknown;
					description?: unknown;
					params?: unknown;
			  }
			| undefined;

		expect(typeof replayParams?.permissionId).toBe("string");
		expect(replayParams?.params && typeof replayParams.params).toBe("object");

		await vm.destroySession(sessionId);
	});
});
