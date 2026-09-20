export interface AssetInspection {
	schemaVersion: "asset-inspection.v1";
	bytes: number;
	kind: "pdf" | "image" | "text" | "file" | "word" | "spreadsheet";
	status: "parsed" | "needs_ocr" | "metadata_only" | "unsupported";
	pages: Array<{ page: number; text: string }>;
	truncated: boolean;
	pageCount?: number;
	width?: number;
	height?: number;
}

export interface AssetInspectionRecord {
	attachmentId: string;
	name: string;
	sha256: string;
	sourceRef: string;
	inspection: AssetInspection;
	parserVersion: "1.0.0" | "1.1.0" | "1.2.0";
	continuation?: { cursor: string | null; offset: number; total: number; sourceTruncated: boolean; error?: string };
}

export function isAssetInspection(value: unknown): value is AssetInspection {
	if (!value || typeof value !== "object") return false;
	const data = value as AssetInspection;
	return data.schemaVersion === "asset-inspection.v1" && Number.isSafeInteger(data.bytes) && data.bytes > 0 && data.bytes <= 10 * 1024 * 1024 &&
		["pdf", "image", "text", "file", "word", "spreadsheet"].includes(data.kind) && ["parsed", "needs_ocr", "metadata_only", "unsupported"].includes(data.status) &&
		typeof data.truncated === "boolean" && Array.isArray(data.pages) && data.pages.length <= 1000 &&
		data.pages.every((page, index) => page && page.page === index + 1 && typeof page.text === "string") &&
		data.pages.reduce((count, page) => count + page.text.length, 0) <= 2_000_000 &&
		[data.pageCount, data.width, data.height].every((number) => number === undefined || Number.isSafeInteger(number) && number > 0);
}
