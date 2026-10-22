import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [react()],
	test: {
		environment: "node",
		// Integration fixtures flush real stores; avoid saturating the disk with CPU-sized concurrency.
		maxWorkers: 4,
		include: ["src/**/*.test.ts", "server/**/*.test.ts", "eval/**/*.test.ts", "src/**/*.test.tsx"],
	},
});
