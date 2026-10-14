import { defineConfig } from "@playwright/test";

const baseURL = "http://127.0.0.1:4178";

export default defineConfig({
	testDir: "./tests/browser",
	fullyParallel: true,
	forbidOnly: Boolean(process.env.CI),
	retries: 0,
	workers: 2,
	reporter: "list",
	outputDir: "./temp/browser-tests",
	use: {
		baseURL,
		browserName: "chromium",
		serviceWorkers: "block",
		trace: "retain-on-failure",
		screenshot: "only-on-failure",
	},
	projects: [
		{ name: "desktop-zh", use: { viewport: { width: 1440, height: 1000 }, locale: "zh-CN" } },
		{ name: "narrow-zh", use: { viewport: { width: 390, height: 844 }, locale: "zh-CN" } },
		{ name: "narrow-en", use: { viewport: { width: 320, height: 568 }, locale: "en-US" } },
	],
	webServer: {
		command: "npm run dev:web -- --host 127.0.0.1 --port 4178 --strictPort",
		url: baseURL,
		reuseExistingServer: false,
		gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
	},
});
