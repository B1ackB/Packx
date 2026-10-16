import { posix, win32 } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

describe.each([
	{ name: "POSIX", paths: posix, root: "/packx/data" },
	{ name: "Windows", paths: win32, root: "C:\\packx\\data" },
])("$name local data boundary", ({ paths, root }) => {
	let within: typeof import("./localData").within;
	beforeAll(async () => {
		vi.resetModules();
		vi.doMock("node:path", () => paths);
		({ within } = await import("./localData"));
	});
	afterAll(() => { vi.doUnmock("node:path"); vi.resetModules(); });

	it.each(["", "artifacts", "nested/file.json", "..notes/file.json"])("allows contained path %j", suffix => {
		expect(within(root, paths.resolve(root, suffix))).toBe(true);
	});
	it.each(["..", "../secret.json", "../data-other/file.json", "nested/../../secret.json"])("rejects escape %j", suffix => {
		expect(within(root, paths.resolve(root, suffix))).toBe(false);
	});
	if (paths === win32) {
		it.each(["C:\\packx\\data\\..\\secret.json", "D:\\packx\\data\\file.json", "\\\\server\\share\\file.json"])("rejects Windows escape %j", target => {
			expect(within(root, target)).toBe(false);
		});
	}
});
