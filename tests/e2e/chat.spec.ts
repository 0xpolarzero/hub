import { expect, type Page, chromium, test } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import * as net from "node:net";

const CDP_PORT = Number(process.env.ELECTROBUN_E2E_CDP_PORT ?? "9333");
const E2E_MESSAGE = "E2E mocked response from fixture mode.";
let appProcess: ChildProcess | null = null;
let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | null = null;
let page: Page | null = null;

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

test("sends a message and receives a mocked response", async () => {
	const messageInput = page!.locator("textarea[placeholder='Type a message...']");
	const question = "What is the current build?";

	await messageInput.fill(question);
	await messageInput.press("Enter");

	await expect(page!.locator("user-message")).toContainText(question, { timeout: 60000 });
	await expect(page!.locator("assistant-message")).toContainText(E2E_MESSAGE, { timeout: 60000 });
});
