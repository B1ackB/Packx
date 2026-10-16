import { closeSync, fsyncSync, openSync } from "node:fs";

/** Callers flush file contents before rename; directory flush is unavailable through Node on Windows. */
export function syncDirectory(directory: string): void {
	// ponytail: Windows guarantees here cover process crashes, not power loss; use a validated native adapter for stronger durability.
	if (process.platform === "win32") return;
	const handle = openSync(directory, "r");
	try { fsyncSync(handle); } finally { closeSync(handle); }
}
