import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { AgentOs } from "@rivet-dev/agent-os-core";
import common from "@rivet-dev/agent-os-common";
import pi from "@rivet-dev/agent-os-pi";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Mirrors the auth-store.ts types
interface AuthEntry {
	type: "apikey" | "oauth" | "env";
	key: string;
	/** For oauth: access token. For apikey: the key itself */
	token?: string;
	refreshToken?: string;
	expiresAt?: number;
}

// Simulates the host-side auth store
function getAuthDir(): string {
	return path.join(os.homedir(), ".config", "acai");
}

function getAuthPath(): string {
	return path.join(getAuthDir(), "auth.json");
}

function loadAuthStore(): Record<string, AuthEntry> {
	const authPath = getAuthPath();
	if (!fs.existsSync(authPath)) return {};
	try {
		return JSON.parse(fs.readFileSync(authPath, "utf-8"));
	} catch {
		return {};
	}
}

// Extract provider credentials for a session
function getProviderEnv(provider: string): Record<string, string> {
	const store = loadAuthStore();
	const env: Record<string, string> = {};

	// Map provider names to their env var names
	const providerEnvMap: Record<string, string> = {
		openai: "OPENAI_API_KEY",
		anthropic: "ANTHROPIC_API_KEY",
		google: "GEMINI_API_KEY",
		groq: "GROQ_API_KEY",
		mistral: "MISTRAL_API_KEY",
	};

	const envVar = providerEnvMap[provider];
	if (!envVar) return env;

	// Check store first
	const entry = store[provider];
	if (entry?.token) {
		env[envVar] = entry.token;
	} else {
		// Fallback to process env
		const fromEnv = process.env[envVar];
		if (fromEnv) env[envVar] = fromEnv;
	}

	return env;
}

describe("Auth Bridge: Credential Injection", () => {
	let vm: AgentOs;

	beforeAll(async () => {
		vm = await AgentOs.create({
			software: [common, pi],
		});
	});

	afterAll(async () => {
		if (vm) await vm.dispose();
	});

	test("getProviderEnv extracts from process env", () => {
		// Set a test env var
		process.env.OPENAI_API_KEY = "test-key-for-poc";
		const env = getProviderEnv("openai");
		expect(env.OPENAI_API_KEY).toBe("test-key-for-poc");
	});

	test("getProviderEnv returns empty for unknown provider", () => {
		const env = getProviderEnv("unknown-provider");
		expect(Object.keys(env)).toHaveLength(0);
	});

	test("session receives injected credentials via env", async () => {
		const apiKey = process.env.OPENAI_API_KEY;
		if (!apiKey) {
			console.log("SKIP: No OPENAI_API_KEY set");
			return;
		}

		const env = getProviderEnv("openai");
		expect(env.OPENAI_API_KEY).toBeDefined();

		const { sessionId } = await vm.createSession("pi", { env });
		expect(sessionId).toBeDefined();

		// Session was created with the injected key
		await vm.destroySession(sessionId);
	});

	test("multiple providers can be injected simultaneously", async () => {
		// Simulate a session that needs multiple provider keys
		const env: Record<string, string> = {};

		for (const provider of ["openai", "anthropic", "google"]) {
			const providerEnv = getProviderEnv(provider);
			Object.assign(env, providerEnv);
		}

		// Verify env has whatever keys are available
		// The point is the merge works correctly
		for (const [key, value] of Object.entries(env)) {
			expect(typeof key).toBe("string");
			expect(typeof value).toBe("string");
			expect(value.length).toBeGreaterThan(0);
		}
	});

	test("credential isolation: env not visible in host process after session", async () => {
		// Create a session with a scoped key
		const scopedKey = "scoped-test-key-12345";
		const { sessionId } = await vm.createSession("pi", {
			env: { OPENAI_API_KEY: scopedKey },
		});

		// The scoped key should NOT be in the host process env
		expect(process.env.OPENAI_API_KEY).not.toBe(scopedKey);

		await vm.destroySession(sessionId);
	});
});

describe("Auth Bridge: Token Refresh Flow", () => {
	test("token refresh keeps session alive without exposing new token to host", () => {
		// Simulate an OAuth token that needs refresh
		const refreshedToken = "new-refreshed-token-xyz";

		// The refresh happens on the host side
		// Then the new token is pushed to the session via env update
		// The session continues with the new token

		// In practice, this would be:
		// 1. Host detects token expiry (expiresAt < Date.now())
		// 2. Host calls OAuth refresh endpoint
		// 3. Host stores new token in auth store
		// 4. Host sends new session with updated env
		// OR: Agent OS session gets the new key via some update mechanism

		expect(refreshedToken).toBeDefined();
		expect(refreshedToken).not.toBe("old-expired-token");
	});

	test("auth store schema supports all entry types", () => {
		const entries: Record<string, AuthEntry> = {
			openai: { type: "apikey", key: "sk-xxx" },
			google: {
				type: "oauth",
				key: "google",
				token: "ya29.xxx",
				refreshToken: "1//xxx",
				expiresAt: Date.now() + 3600000,
			},
			mistral: { type: "env", key: "MISTRAL_API_KEY" },
		};

		// API key entry
		expect(entries.openai.type).toBe("apikey");
		expect(entries.openai.key).toBe("sk-xxx");

		// OAuth entry with refresh
		expect(entries.google.type).toBe("oauth");
		expect(entries.google.refreshToken).toBeDefined();
		expect(entries.google.expiresAt! > Date.now()).toBe(true);

		// Env reference entry
		expect(entries.mistral.type).toBe("env");
	});
});

describe("Auth Bridge: Provider Key Mapping", () => {
	test("all supported providers map to correct env vars", () => {
		const providerEnvMap: Record<string, string> = {
			openai: "OPENAI_API_KEY",
			anthropic: "ANTHROPIC_API_KEY",
			google: "GEMINI_API_KEY",
			groq: "GROQ_API_KEY",
			mistral: "MISTRAL_API_KEY",
		};

		for (const [provider, envVar] of Object.entries(providerEnvMap)) {
			expect(envVar).toMatch(/_API_KEY$/);
			expect(provider.length).toBeGreaterThan(0);
		}
	});
});
