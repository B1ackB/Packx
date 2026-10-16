import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { documentCapabilityText } from "../../src/runtime/hostCapabilities";
import { assertDocumentUpload, documentCapabilities } from "./documentCapabilities";

it("reports component presence without claiming that isolation has already passed", () => {
	const root = mkdtempSync(join(tmpdir(), "packx-doc-capability-"));
	try {
		expect(documentCapabilities("win32", root)).toMatchObject({ scope: "windows-utf8", components: "missing", maxBytes: 131072, isolationVerification: "per-execution" });
		for (const name of ["text-inspector.exe", "text-inspector-worker.exe"]) writeFileSync(join(root, name), "component-presence-fixture-only");
		const present = documentCapabilities("win32", root); expect(present.components).toBe("present");
		expect(documentCapabilityText(present, false)).toContain("每次读取均检查");
		expect(documentCapabilities("linux", root).components).toBe("unsupported");
	} finally { rmSync(root, { recursive: true, force: true }); }
});
it("rejects unsupported Windows uploads and size limits before storage", () => {
	const capability = documentCapabilities("win32", "missing-fixture-directory");
	for (const name of ["customer.pdf", "报价.docx", "sheet.xlsx", "scan.png", "data.exe"]) expect(() => assertDocumentUpload(capability, name, 20)).toThrow("仅支持");
	for (const size of [0, 131073, NaN]) expect(() => assertDocumentUpload(capability, "中文 文件.TXT", size)).toThrow("128 KiB");
	expect(() => assertDocumentUpload(capability, "中文 文件.TXT", 131072)).not.toThrow();
});
