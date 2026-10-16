import { createHash } from "node:crypto";
import type { AssetInspection } from "../../src/runtime/assetInspection";

export type TextDocumentErrorCode = "cancelled" | "unsupported_format" | "empty_input" | "input_limit" | "source_mismatch" | "binary_content" | "invalid_encoding" | "output_limit";
export class TextDocumentError extends Error {
	readonly retryable = false;
	constructor(readonly code: TextDocumentErrorCode) { super(`Text document rejected: ${code}`); this.name = "TextDocumentError"; }
}

/** Pure byte contract for a future isolated worker. No file access, Tool registration, or Host fallback. */
export function inspectUtf8TextDocument(input: { bytes: Uint8Array; expectedSha256: string; format: string; signal: AbortSignal }) {
	const fail = (code: TextDocumentErrorCode): never => { throw new TextDocumentError(code); };
	if (input.signal.aborted) fail("cancelled");
	if (!["txt", "md", "csv", "json"].includes(input.format)) fail("unsupported_format");
	if (input.bytes.byteLength === 0) fail("empty_input");
	if (input.bytes.byteLength > 10 * 1024 * 1024) fail("input_limit");
	// Freeze one bounded byte view for both the digest and decoding, including a possible UTF-8 BOM.
	const bytes = Buffer.from(input.bytes);
	const sourceSha256 = createHash("sha256").update(bytes).digest("hex");
	if (!/^[a-f0-9]{64}$/.test(input.expectedSha256) || sourceSha256 !== input.expectedSha256) fail("source_mismatch");
	if (bytes.subarray(0, 5).equals(Buffer.from("%PDF-")) || (bytes[0] === 0x50 && bytes[1] === 0x4b && [0x0403, 0x0605, 0x0807].includes(bytes.length >= 4 ? bytes.readUInt16LE(2) : -1))) fail("unsupported_format");
	if (bytes.includes(0)) fail("binary_content");
	let text: string;
	try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
	catch { return fail("invalid_encoding"); }
	if (text.length === 0) fail("empty_input");
	if (text.length > 1_000_000) fail("output_limit");
	if (input.signal.aborted) fail("cancelled");
	const inspection: AssetInspection = { schemaVersion: "asset-inspection.v1", bytes: bytes.length, kind: "text", status: "parsed", pages: [{ page: 1, text, method: "text" }], pageCount: 1, truncated: false };
	return { parserId: "bounded-utf8-text.v1" as const, sourceSha256, inspection };
}
