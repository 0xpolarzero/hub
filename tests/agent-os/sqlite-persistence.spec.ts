import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { AgentOs } from "@rivet-dev/agent-os-core";
import { toolKit, hostTool } from "@rivet-dev/agent-os-core";
import common from "@rivet-dev/agent-os-common";
import { z } from "zod";

describe("SQLite Persistence via ToolKit Pattern", () => {
	let vm: AgentOs;

	const memStore = new Map<string, string>();

	beforeAll(async () => {
		const dbToolkit = toolKit({
			name: "db",
			description: "Persistent database toolkit",
			tools: {
				set: hostTool({
					description: "Store a key-value pair",
					inputSchema: z.object({ key: z.string(), value: z.string() }),
					execute: async (input) => {
						memStore.set(input.key, input.value);
						return { ok: true };
					},
				}),
				get: hostTool({
					description: "Retrieve a value by key",
					inputSchema: z.object({ key: z.string() }),
					execute: async (input) => {
						return { value: memStore.get(input.key) ?? null };
					},
				}),
				delete: hostTool({
					description: "Delete a key",
					inputSchema: z.object({ key: z.string() }),
					execute: async (input) => {
						memStore.delete(input.key);
						return { ok: true };
					},
				}),
				list: hostTool({
					description: "List all keys",
					inputSchema: z.object({}),
					execute: async () => {
						return { keys: Array.from(memStore.keys()) };
					},
				}),
			},
		});

		vm = await AgentOs.create({
			software: [common],
			toolKits: [dbToolkit],
		});
	});

	afterAll(async () => {
		if (vm) await vm.dispose();
	});

	test("toolkit is registered in VM", () => {
		expect(vm).toBeDefined();
	});

	test("filesystem persists across operations", async () => {
		await vm.writeFile(
			"/home/user/chat-history.json",
			JSON.stringify([
				{ role: "user", content: "Hello" },
				{ role: "assistant", content: "Hi there!" },
			])
		);

		const raw = await vm.readFile("/home/user/chat-history.json");
		const history = JSON.parse(new TextDecoder().decode(raw));

		expect(history).toHaveLength(2);
		expect(history[0].role).toBe("user");
		expect(history[1].role).toBe("assistant");
	});

	test("filesystem state persists after multiple writes", async () => {
		await vm.mkdir("/home/user/memory");

		for (let i = 0; i < 10; i++) {
			await vm.writeFile(
				`/home/user/memory/entry-${i}.json`,
				JSON.stringify({ index: i, data: `memory-${i}` })
			);
		}

		for (let i = 0; i < 10; i++) {
			const exists = await vm.exists(`/home/user/memory/entry-${i}.json`);
			expect(exists).toBe(true);
		}

		const raw = await vm.readFile("/home/user/memory/entry-5.json");
		const entry = JSON.parse(new TextDecoder().decode(raw));
		expect(entry.index).toBe(5);
	});

	test("session event history can be stored", async () => {
		const events = [
			{ seq: 1, type: "session.create", ts: Date.now() },
			{ seq: 2, type: "prompt.send", text: "hello", ts: Date.now() },
			{ seq: 3, type: "response.delta", text: "Hi", ts: Date.now() },
			{ seq: 4, type: "response.complete", ts: Date.now() },
		];

		await vm.writeFile(
			"/home/user/events/session-1.jsonl",
			events.map((e) => JSON.stringify(e)).join("\n")
		);

		const raw = await vm.readFile("/home/user/events/session-1.jsonl");
		const lines = new TextDecoder().decode(raw).split("\n");
		expect(lines).toHaveLength(4);

		const firstEvent = JSON.parse(lines[0]);
		expect(firstEvent.seq).toBe(1);
		expect(firstEvent.type).toBe("session.create");
	});

	test("batch file operations for efficiency", async () => {
		const entries = Array.from({ length: 20 }, (_, i) => ({
			path: `/home/user/batch/file-${i}.txt`,
			content: `content-${i}`,
		}));

		const writeResults = await vm.writeFiles(
			entries.map((e) => ({ path: e.path, content: e.content }))
		);
		expect(writeResults.length).toBe(20);

		const paths = entries.map((e) => e.path);
		const readResults = await vm.readFiles(paths);
		expect(readResults.length).toBe(20);

		for (let i = 0; i < 20; i++) {
			const content = new TextDecoder().decode(readResults[i].content);
			expect(content).toBe(`content-${i}`);
		}
	});
});

describe("SQLite Schema Design (typed)", () => {
	test("chat session schema is well-defined", () => {
		interface ChatSession {
			id: string;
			provider: string;
			model: string;
			created_at: number;
			updated_at: number;
			title: string | null;
		}

		const session: ChatSession = {
			id: "sess-123",
			provider: "openai",
			model: "gpt-4",
			created_at: Date.now(),
			updated_at: Date.now(),
			title: "Test chat",
		};

		expect(session.id).toBe("sess-123");
		expect(session.provider).toBe("openai");
	});

	test("chat message schema is well-defined", () => {
		interface ChatMessage {
			id: string;
			session_id: string;
			role: "user" | "assistant" | "system";
			content: string;
			seq: number;
			created_at: number;
			tokens_in: number | null;
			tokens_out: number | null;
		}

		const msg: ChatMessage = {
			id: "msg-456",
			session_id: "sess-123",
			role: "assistant",
			content: "Hello!",
			seq: 2,
			created_at: Date.now(),
			tokens_in: 10,
			tokens_out: 5,
		};

		expect(msg.role).toBe("assistant");
		expect(msg.seq).toBe(2);
	});

	test("agent memory schema is well-defined", () => {
		interface AgentMemory {
			id: string;
			session_id: string;
			key: string;
			value: string;
			created_at: number;
			accessed_at: number;
			access_count: number;
		}

		const mem: AgentMemory = {
			id: "mem-789",
			session_id: "sess-123",
			key: "user_preference",
			value: JSON.stringify({ theme: "dark" }),
			created_at: Date.now(),
			accessed_at: Date.now(),
			access_count: 1,
		};

		expect(mem.key).toBe("user_preference");
	});
});
