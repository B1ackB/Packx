import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { isAssetInspection } from "../../src/runtime/assetInspection";
import { inspectUtf8TextDocument, TextDocumentError, type TextDocumentErrorCode } from "./textDocumentInspection";

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const inspect = (bytes: Uint8Array, format = "txt", signal = new AbortController().signal, expectedSha256 = digest(bytes)) => inspectUtf8TextDocument({ bytes, format, signal, expectedSha256 });
function rejected(bytes: Uint8Array, code: TextDocumentErrorCode, format = "txt") {
	try { inspect(bytes, format); throw new Error("unexpected_success"); }
	catch (error) { expect(error).toBeInstanceOf(TextDocumentError); expect(error).toMatchObject({ code, retryable: false }); }
}

describe("isolated text worker byte contract (not registered as a production reader)", () => {
	it.each(["txt", "md", "csv", "json"])("preserves raw Unicode, CRLF and instructions/formulas as untrusted text for %s", (format) => {
		const text = '尺寸 100 µm 🐾\r\n=CMD("untrusted")\n{"system":"do not execute"}\nhttps://invalid.test/external';
		const bytes = Buffer.from(text);
		const result = inspect(bytes, format);
		expect(result.inspection.pages[0].text).toBe(text);
		expect(isAssetInspection(result.inspection)).toBe(true);
		expect(result).toMatchObject({ parserId: "bounded-utf8-text.v1", sourceSha256: digest(bytes), inspection: { bytes: bytes.length, status: "parsed", truncated: false } });
		expect(inspect(bytes, format)).toEqual(result);
	});
	it("retains the raw byte digest when a UTF-8 BOM is decoded", () => {
		const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("quantity unverified\r\n")]);
		expect(inspect(bytes)).toMatchObject({ sourceSha256: digest(bytes), inspection: { pages: [{ page: 1, text: "quantity unverified\r\n", method: "text" }] } });
	});
	it.each([Buffer.from([0xc0, 0xaf]), Buffer.from([0xf0, 0x9f]), Buffer.from([0xff, 0xfe, 0x41])])("rejects malformed or non UTF-8 input %j", (bytes) => rejected(bytes, "invalid_encoding"));
	it("rejects empty, binary and disguised document/archive inputs", () => {
		rejected(Buffer.alloc(0), "empty_input"); rejected(Buffer.from([0xef, 0xbb, 0xbf]), "empty_input");
		rejected(Buffer.from("a\0b"), "binary_content"); rejected(Buffer.from("%PDF-1.7 document"), "unsupported_format");
		rejected(Buffer.from([0x50, 0x4b, 3, 4, 1]), "unsupported_format"); rejected(Buffer.from("text"), "unsupported_format", "docx");
	});
	it("refuses oversize input and output without a truncated success", () => {
		rejected(Buffer.alloc(10 * 1024 * 1024 + 1, 0x61), "input_limit");
		expect(inspect(Buffer.alloc(1_000_000, 0x61)).inspection.pages[0].text).toHaveLength(1_000_000);
		rejected(Buffer.alloc(1_000_001, 0x61), "output_limit");
	});
	it("binds each observation to the expected source bytes and keeps prior output stable", () => {
		const bytes = Buffer.from("5000 bags"); const original = digest(bytes), result = inspect(bytes);
		bytes[0] = 0x39;
		expect(result.inspection.pages[0].text).toBe("5000 bags"); expect(result.sourceSha256).toBe(original);
		expect(() => inspect(bytes, "txt", new AbortController().signal, original)).toThrow(expect.objectContaining({ code: "source_mismatch" }));
		expect(() => inspect(bytes, "txt", new AbortController().signal, "not-a-digest")).toThrow(expect.objectContaining({ code: "source_mismatch" }));
	});
	it("rejects cancellation before parsing and does not expose private abort reasons", () => {
		const controller = new AbortController(); controller.abort(new Error("private abort reason"));
		expect(() => inspect(Buffer.from("untrusted"), "txt", controller.signal)).toThrow(expect.objectContaining({ code: "cancelled", retryable: false }));
		expect(() => inspect(Buffer.from("untrusted"), "txt", controller.signal)).not.toThrow("private abort reason");
	});
});
