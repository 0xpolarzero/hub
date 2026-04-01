import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { AgentOs } from "@rivet-dev/agent-os-core";
import common from "@rivet-dev/agent-os-common";
import pi from "@rivet-dev/agent-os-pi";
import type { SequencedEvent } from "@rivet-dev/agent-os-core";

describe("Agent OS VM Lifecycle", () => {
	let vm: AgentOs;

	beforeAll(async () => {
		vm = await AgentOs.create({
			software: [common, pi],
		});
	});

	afterAll(async () => {
		if (vm) await vm.dispose();
	});

	test("VM boots and has agents registered", () => {
		const agents = vm.listAgents();
		expect(agents.length).toBeGreaterThan(0);
		const piAgent = agents.find((a) => a.id === "pi");
		expect(piAgent).toBeDefined();
	});

	test("filesystem operations work in VM", async () => {
		await vm.writeFile("/home/user/test.txt", "hello from acai");
		const content = await vm.readFile("/home/user/test.txt");
		expect(new TextDecoder().decode(content)).toBe("hello from acai");
	});

	test("filesystem mkdir and readdir", async () => {
		await vm.mkdir("/home/user/testdir");
		await vm.writeFile("/home/user/testdir/a.txt", "a");
		await vm.writeFile("/home/user/testdir/b.txt", "b");

		const entries = await vm.readdir("/home/user/testdir");
		expect(entries.sort()).toEqual(["a.txt", "b.txt"]);
	});

	test("process exec works in VM", async () => {
		const result = await vm.exec("echo 'hello world'");
		expect(result.exitCode).toBe(0);
		expect(result.stdout.trim()).toBe("hello world");
	});

	test("process exec with pipes", async () => {
		const result = await vm.exec("echo 'line1\nline2\nline3' | wc -l");
		expect(result.exitCode).toBe(0);
		expect(parseInt(result.stdout.trim())).toBe(3);
	});

	test("exists and stat", async () => {
		await vm.writeFile("/home/user/stat-test.txt", "content");
		const exists = await vm.exists("/home/user/stat-test.txt");
		expect(exists).toBe(true);

		const stat = await vm.stat("/home/user/stat-test.txt");
		expect(stat.isDirectory).toBe(false);
		expect(stat.size).toBeGreaterThan(0);
	});

	test("move and delete", async () => {
		await vm.writeFile("/home/user/src.txt", "move me");
		await vm.move("/home/user/src.txt", "/home/user/dst.txt");

		const srcExists = await vm.exists("/home/user/src.txt");
		expect(srcExists).toBe(false);

		const dstContent = await vm.readFile("/home/user/dst.txt");
		expect(new TextDecoder().decode(dstContent)).toBe("move me");

		await vm.delete("/home/user/dst.txt");
		const dstExists = await vm.exists("/home/user/dst.txt");
		expect(dstExists).toBe(false);
	});

	test("spawn long-running process", async () => {
		const { pid } = vm.spawn("sleep", ["2"]);

		const processes = vm.listProcesses();
		expect(processes.some((p) => p.pid === pid)).toBe(true);

		const exitCode = await vm.waitProcess(pid);
		expect(exitCode).toBe(0);
	});

	test("create Pi session", async () => {
		const apiKey = process.env.OPENAI_API_KEY;
		if (!apiKey) {
			console.log("SKIP: No OPENAI_API_KEY set");
			return;
		}

		const { sessionId } = await vm.createSession("pi", {
			env: { OPENAI_API_KEY: apiKey },
		});

		expect(sessionId).toBeDefined();
		expect(typeof sessionId).toBe("string");

		const sessions = vm.listSessions();
		expect(sessions.some((s) => s.sessionId === sessionId)).toBe(true);

		await vm.destroySession(sessionId);
	});

	test("send prompt and receive events", async () => {
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

		await vm.prompt(sessionId, "Say exactly: pong");

		unsub();
		expect(events.length).toBeGreaterThan(0);

		await vm.destroySession(sessionId);
	});

	test("session close and cleanup", async () => {
		const apiKey = process.env.OPENAI_API_KEY;
		if (!apiKey) {
			console.log("SKIP: No OPENAI_API_KEY set");
			return;
		}

		const { sessionId } = await vm.createSession("pi", {
			env: { OPENAI_API_KEY: apiKey },
		});

		vm.closeSession(sessionId);
		const sessions = vm.listSessions();
		expect(sessions.some((s) => s.sessionId === sessionId)).toBe(false);
	});
});
