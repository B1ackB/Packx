import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { cleanupBuildResources, execFileUntilClosed } from "../scripts/windowsBuildJob";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));
afterEach(() => vi.resetAllMocks());

it("does not settle AbortError until supervisor close (deterministic event-order fixture)", async () => {
	const child = new EventEmitter(); let callback!: (error: Error | null, stdout: string, stderr: string) => void;
	vi.mocked(execFile).mockImplementation(((_file: unknown, _args: unknown, _options: unknown, done: typeof callback) => { callback = done; return child; }) as typeof execFile);
	const primary = Object.assign(new Error("cancelled during supervisor startup"), { code: "ABORT_ERR" });
	let settled = false, failure: unknown;
	const work = execFileUntilClosed("fixture", [], { encoding: "utf8" }).then(() => { settled = true; }, (error) => { settled = true; failure = error; });
	callback(primary, "partial output", "original diagnostic"); await Promise.resolve();
	expect(settled).toBe(false); child.emit("close", null, "SIGTERM"); await work;
	expect(failure).toBe(primary); expect(failure).toMatchObject({ code: "ABORT_ERR", stdout: "partial output", stderr: "original diagnostic" });
});

it("waits for both callback and close regardless of order", async () => {
	const child = new EventEmitter(); let callback!: (error: Error | null, stdout: string, stderr: string) => void;
	vi.mocked(execFile).mockImplementation(((_file: unknown, _args: unknown, _options: unknown, done: typeof callback) => { callback = done; return child; }) as typeof execFile);
	let settled = false; const work = execFileUntilClosed("fixture", [], { encoding: "utf8" }).then((value) => { settled = true; return value; });
	child.emit("close", 0); await Promise.resolve(); expect(settled).toBe(false);
	callback(null, "output", "diagnostic"); expect(await work).toEqual({ stdout: "output", stderr: "diagnostic" });
});

it("preserves primary and cleanup errors together without swallowing EPERM", () => {
	const primary = Object.assign(new Error("fixture handshake failed"), { code: "ETIMEDOUT" });
	const cleanup = Object.assign(new Error("directory still held"), { code: "EPERM" });
	let failure: unknown; try { cleanupBuildResources(() => { throw cleanup; }, primary); } catch (error) { failure = error; }
	expect(failure).toBeInstanceOf(AggregateError); expect((failure as AggregateError).errors).toEqual([primary, cleanup]);
	expect((failure as Error).cause).toBe(primary); expect((failure as Error).message).toContain("fixture handshake failed");
});
