import { expect, type Page, chromium, test } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import * as net from "node:net";

const CDP_PORT = Number(process.env.ELECTROBUN_E2E_CDP_PORT ?? "9333");
const E2E_ENV_FILES = [".env.e2e.local", ".env.e2e", ".env.local", ".env"];
let appProcess: ChildProcess | null = null;
let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | null = null;
let page: Page | null = null;

function loadProcessEnvFromFiles() {
	for (const file of E2E_ENV_FILES) {
		if (!existsSync(file)) continue;

		const content = readFileSync(file, "utf8");
		for (const rawLine of content.split(/\r?\n/)) {
			const line = rawLine.trim();
			if (!line || line.startsWith("#")) continue;

			const equalsIndex = line.indexOf("=");
			if (equalsIndex < 0) continue;

			const key = line.slice(0, equalsIndex).trim();
			if (!key || process.env[key] !== undefined) continue;

			let value = line.slice(equalsIndex + 1).trim();
			if (
				(value.startsWith('"') && value.endsWith('"')) ||
				(value.startsWith("'") && value.endsWith("'"))
			) {
				value = value.slice(1, -1);
			}

			if (value) {
				process.env[key] = value;
			}
		}
	}
}

loadProcessEnvFromFiles();

test.skip(!process.env.ZAI_API_KEY, "ZAI_API_KEY is required to run the live e2e chat test.");

function waitForSocket(port: number, timeoutMs: number): Promise<void> {
	return new Promise((resolve, reject) => {
		const start = Date.now();
		const check = () => {
			const socket = net.createConnection({ host: "127.0.0.1", port });
			socket.once("connect", () => {
				socket.destroy();
				resolve();
			});
			socket.once("error", () => {
				socket.destroy();
				if (Date.now() - start >= timeoutMs) {
					reject(new Error(`Timed out waiting for app debug socket on port ${port}`));
					return;
				}
				setTimeout(check, 250);
			});
		};
		check();
	});
}

async function getWebSocketUrl(port: number, timeoutMs: number): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const response = await fetch(`http://127.0.0.1:${port}/json/version`);
			if (response.ok) {
				const payload = (await response.json()) as { webSocketDebuggerUrl?: string };
				if (payload.webSocketDebuggerUrl) {
					return payload.webSocketDebuggerUrl;
				}
			}
		} catch {}
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	throw new Error(`Timed out waiting for CDP websocket URL on port ${port}`);
}

async function findMainPage() {
	if (!browser) throw new Error("Browser not initialized");
	for (let attempt = 0; attempt < 80; attempt++) {
		for (const context of browser.contexts()) {
			for (const candidate of context.pages()) {
				if ((await candidate.locator("textarea[placeholder='Type a message...']").count()) > 0) {
					return candidate;
				}
			}
		}
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	throw new Error("App page not available in CDP targets");
}

test.beforeAll(async () => {
	appProcess = spawn("bun", ["run", "test:e2e:start"], {
		env: {
			...process.env,
			E2E: "1",
			ELECTROBUN_E2E: "1",
			ELECTROBUN_E2E_CDP_PORT: String(CDP_PORT),
		},
		stdio: "ignore",
	});

	await waitForSocket(CDP_PORT, 120000);
	const ws = await getWebSocketUrl(CDP_PORT, 120000);
	browser = await chromium.connectOverCDP(ws);
	page = await findMainPage();
	await page.waitForLoadState("domcontentloaded");
	await expect(page.locator("textarea[placeholder='Type a message...']")).toBeVisible({ timeout: 60000 });
});

test.afterAll(async () => {
	if (page) await page.close().catch(() => {});
	if (browser) await browser.close();
	if (appProcess) appProcess.kill("SIGINT");
});

test("sends a message and receives a live response", async () => {
	const messageInput = page!.locator("textarea[placeholder='Type a message...']");
	const question = "What is the current build?";

	await messageInput.fill(question);
	await messageInput.press("Enter");

	await expect(page!.locator("user-message")).toContainText(question, { timeout: 60000 });
	const assistantMessage = page!.locator("assistant-message").last();
	await expect(assistantMessage).toContainText(/\S+/u, { timeout: 120000 });
	const assistantPayload = await assistantMessage.evaluate((el) => {
		const message = (el as { message?: Record<string, unknown> }).message;
		const content = Array.isArray(message?.content) ? message.content : [];
		const text = content
			.filter((block: { type?: string; text?: unknown }) => block?.type === "text" && typeof block.text === "string")
			.map((block: { text?: string }) => block.text ?? "")
			.join("")
			.trim();

		return {
			stopReason: (message?.stopReason as string | null) ?? null,
			provider: (message?.provider as string | null) ?? null,
			model: (message?.model as string | null) ?? null,
			text,
		};
	});

	expect(["stop", "length", "toolUse"]).toContain(assistantPayload.stopReason);
	expect(assistantPayload.provider).toBe("zai");
	expect(assistantPayload.model).toBe("glm-4.5");
	expect(assistantPayload.text.length).toBeGreaterThan(0);
	expect(assistantPayload.text).not.toContain("Error:");
});
