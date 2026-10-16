import { closeSync, fsyncSync, openSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { syncDirectory } from "./syncDirectory";

vi.mock("node:fs", () => ({ openSync: vi.fn(() => 7), fsyncSync: vi.fn(), closeSync: vi.fn() }));
afterEach(() => { vi.unstubAllGlobals(); vi.resetAllMocks(); });

it("does not attempt unsupported directory flushing on Windows", () => {
	vi.stubGlobal("process", { ...process, platform: "win32" });
	syncDirectory("directory");
	expect(openSync).not.toHaveBeenCalled();
});

it("flushes and closes directory handles on POSIX", () => {
	vi.stubGlobal("process", { ...process, platform: "darwin" });
	vi.mocked(openSync).mockReturnValue(7);
	syncDirectory("directory");
	expect(openSync).toHaveBeenCalledWith("directory", "r");
	expect(fsyncSync).toHaveBeenCalledWith(7);
	expect(closeSync).toHaveBeenCalledWith(7);
});

it("propagates real flush failures and still closes the handle", () => {
	vi.stubGlobal("process", { ...process, platform: "linux" });
	vi.mocked(openSync).mockReturnValue(7);
	vi.mocked(fsyncSync).mockImplementation(() => { throw new Error("synthetic_flush_failure"); });
	expect(() => syncDirectory("directory")).toThrow("synthetic_flush_failure");
	expect(closeSync).toHaveBeenCalledWith(7);
});
