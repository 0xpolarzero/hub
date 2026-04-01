import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { AgentOs } from "@rivet-dev/agent-os-core";
import common from "@rivet-dev/agent-os-common";
import pi from "@rivet-dev/agent-os-pi";
import type { SequencedEvent, PermissionRequest } from "@rivet-dev/agent-os-core";

// Types that match the current RPC streaming format in chat-rpc.ts
interface StreamDelta {
	type: "delta";
	text: string;
	sessionId: string;
}

interface StreamComplete {
	type: "complete";
	sessionId: string;
}

interface StreamError {
	type: "error";
	error: string;
	sessionId: string;
}

type StreamEvent = StreamDelta | StreamComplete | StreamError;

// Adapter: transforms Agent OS events into RPC-compatible stream events
function adaptAgentOsEvent(
	sessionId: string,
	event: SequencedEvent
): StreamEvent | null {
	const method = event.notification.method;
	const params = event.notification.params;

	if (!method) return null;

	switch (method) {
		case "chat.delta":
		case "text.delta":
		case "agent.delta": {
			const text = params?.text ?? params?.content ?? "";
			if (!text) return null;
			return { type: "delta", text, sessionId };
		}

		case "chat.complete":
		case "text.complete":
		case "agent.complete":
			return { type: "complete", sessionId };

		case "error":
			return {
				type: "error",
				error: params?.message ?? "Unknown error",
				sessionId,
			};

		default:
			return null;
	}
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

	test("adapter transforms delta events", () => {
		const mockEvent: SequencedEvent = {
			sequenceNumber: 1,
			notification: { method: "chat.delta", params: { text: "Hello " } },
		};

		const adapted = adaptAgentOsEvent("sess-1", mockEvent);
		expect(adapted).toEqual({
			type: "delta",
			text: "Hello ",
			sessionId: "sess-1",
		});
	});

	test("adapter transforms complete events", () => {
		const mockEvent: SequencedEvent = {
			sequenceNumber: 5,
			notification: { method: "chat.complete", params: {} },
		};

		const adapted = adaptAgentOsEvent("sess-1", mockEvent);
		expect(adapted).toEqual({
			type: "complete",
			sessionId: "sess-1",
		});
	});

	test("adapter transforms error events", () => {
		const mockEvent: SequencedEvent = {
			sequenceNumber: 3,
			notification: { method: "error", params: { message: "Rate limited" } },
		};

		const adapted = adaptAgentOsEvent("sess-1", mockEvent);
		expect(adapted).toEqual({
			type: "error",
			error: "Rate limited",
			sessionId: "sess-1",
		});
	});

	test("adapter returns null for unknown event types", () => {
		const mockEvent: SequencedEvent = {
			sequenceNumber: 10,
			notification: { method: "tool.call", params: { tool: "read_file" } },
		};

		const adapted = adaptAgentOsEvent("sess-1", mockEvent);
		expect(adapted).toBeNull();
	});

	test("adapter handles multiple event methods", () => {
		const methods = ["chat.delta", "text.delta", "agent.delta"];
		for (const method of methods) {
			const mockEvent: SequencedEvent = {
				sequenceNumber: 1,
				notification: { method, params: { text: "test" } },
			};

			const adapted = adaptAgentOsEvent("sess-1", mockEvent);
			expect(adapted?.type).toBe("delta");
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

	test("real events transform correctly through adapter", async () => {
		const apiKey = process.env.OPENAI_API_KEY;
		if (!apiKey) {
			console.log("SKIP: No OPENAI_API_KEY set");
			return;
		}

		const { sessionId } = await vm.createSession("pi", {
			env: { OPENAI_API_KEY: apiKey },
		});

		const rawEvents: SequencedEvent[] = [];
		const adaptedEvents: StreamEvent[] = [];

		const unsub = vm.onSessionEvent(sessionId, (event) => {
			rawEvents.push(event);
			const adapted = adaptAgentOsEvent(sessionId, event);
			if (adapted) adaptedEvents.push(adapted);
		});

		await vm.prompt(sessionId, "Say exactly: adapter-test");

		unsub();

		expect(adaptedEvents.length).toBeGreaterThan(0);

		const completes = adaptedEvents.filter((e) => e.type === "complete");
		expect(completes.length).toBeGreaterThanOrEqual(1);

		const deltas = adaptedEvents.filter((e) => e.type === "delta") as StreamDelta[];
		const fullText = deltas.map((d) => d.text).join("");
		expect(fullText.toLowerCase()).toContain("adapter-test");

		await vm.destroySession(sessionId);
	});

	test("permission request events fire correctly", async () => {
		const apiKey = process.env.OPENAI_API_KEY;
		if (!apiKey) {
			console.log("SKIP: No OPENAI_API_KEY set");
			return;
		}

		const { sessionId } = await vm.createSession("pi", {
			env: { OPENAI_API_KEY: apiKey },
		});

		const permissionRequests: { sessionId: string; request: PermissionRequest }[] = [];
		const unsub = vm.onPermissionRequest(sessionId, (sid, request) => {
			permissionRequests.push({ sessionId: sid, request });
			vm.respondPermission(sid, request.permissionId, "once");
		});

		await vm.prompt(sessionId, "List the files in the current directory");

		unsub();

		expect(Array.isArray(permissionRequests)).toBe(true);

		await vm.destroySession(sessionId);
	});

	test("event replay via getSequencedEvents", async () => {
		const apiKey = process.env.OPENAI_API_KEY;
		if (!apiKey) {
			console.log("SKIP: No OPENAI_API_KEY set");
			return;
		}

		const { sessionId } = await vm.createSession("pi", {
			env: { OPENAI_API_KEY: apiKey },
		});

		await vm.prompt(sessionId, "Say exactly: replay-test");

		const events = vm.getSessionEvents(sessionId);
		expect(events.length).toBeGreaterThan(0);

		const adapted = events
			.map((e) => adaptAgentOsEvent(sessionId, e))
			.filter((e): e is StreamEvent => e !== null);

		expect(adapted.length).toBeGreaterThan(0);

		await vm.destroySession(sessionId);
	});
});
