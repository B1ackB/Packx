import { lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import type { DocumentCapabilities } from "../../src/runtime/hostCapabilities";

export function documentCapabilities(platform: NodeJS.Platform = process.platform, directory = resolve(".blackx-tools")): DocumentCapabilities {
	const windows = platform === "win32", mac = platform === "darwin";
	const binaries = windows ? ["text-inspector.exe", "text-inspector-worker.exe"] : mac ? ["asset-inspector", "tool-supervisor"] : [];
	const present = binaries.every((name) => { try { const info = lstatSync(join(directory, name)); return info.isFile() && !info.isSymbolicLink() && info.nlink === 1; } catch { return false; } });
	return { scope: windows ? "windows-utf8" : mac ? "macos-documents" : "unavailable", components: !binaries.length ? "unsupported" : present ? "present" : "missing",
		extensions: windows ? ["txt", "md", "csv", "json"] : mac ? ["pdf", "docx", "xlsx", "txt", "md", "csv", "json", "png", "jpg", "jpeg"] : [], maxBytes: windows ? 131072 : mac ? 10 * 1024 * 1024 : 0, isolationVerification: "per-execution" };
}

export class UnsupportedDocumentError extends Error {
	constructor(readonly code: "unsupported_document_format" | "document_size_limit", message: string) { super(message); }
}
export function assertDocumentUpload(capability: DocumentCapabilities, name: string, bytes: number) {
	if (capability.scope !== "windows-utf8") return;
	if (!/\.(txt|md|csv|json)$/i.test(name)) throw new UnsupportedDocumentError("unsupported_document_format", "Windows 仅支持 UTF-8 txt/md/csv/json 附件；PDF、Office、图片与扫描识别尚不可用。");
	if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > capability.maxBytes) throw new UnsupportedDocumentError("document_size_limit", "Windows 文本附件须为 1 字节至 128 KiB。");
}
