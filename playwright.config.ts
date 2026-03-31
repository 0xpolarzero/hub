import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "./tests/e2e",
	timeout: 120000,
	workers: 1,
	retries: 0,
	reporter: [["list"]],
	use: {
		screenshot: "off",
		video: "off",
		trace: "off",
		actionTimeout: 15000,
		navigationTimeout: 60000,
	},
});
