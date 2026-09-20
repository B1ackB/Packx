import Foundation
import PDFKit
import ImageIO
import Darwin

func wholeLines(_ text: String, limit: Int) -> String {
	if text.count <= limit { return text }
	var result = ""; var count = 0
	for line in text.components(separatedBy: "\n") {
		let size = line.count + 1
		if count + size > limit { break }
		result += line + "\n"; count += size
	}
	return result
}

// Trusted, fixed executable. The Host supplies one staged input; no scripts or URLs.
var cpuLimit = rlimit(rlim_cur: 5, rlim_max: 5)
guard setrlimit(RLIMIT_CPU, &cpuLimit) == 0, CommandLine.arguments.count == 2 else { exit(2) }
let url = URL(fileURLWithPath: CommandLine.arguments[1])
guard let data = try? Data(contentsOf: url), !data.isEmpty, data.count <= 10 * 1024 * 1024 else { exit(2) }
var result: [String: Any] = ["schemaVersion": "asset-inspection.v1", "bytes": data.count, "pages": [], "truncated": false]
if data.starts(with: Data("%PDF-".utf8)) {
	guard let document = PDFDocument(data: data), !document.isLocked, document.pageCount > 0 else { exit(3) }
	var pages: [[String: Any]] = []
	var remaining = 1_000_000
	var truncated = document.pageCount > 1000
	for index in 0..<min(document.pageCount, 1000) {
		guard remaining > 0 else { truncated = true; break }
		let text = document.page(at: index)?.string ?? ""
		let bounded = wholeLines(text, limit: remaining)
		if bounded.count < text.count { truncated = true }
		remaining -= bounded.count
		pages.append(["page": index + 1, "text": bounded])
	}
	result["kind"] = "pdf"
	result["pageCount"] = document.pageCount
	result["pages"] = pages
	result["truncated"] = truncated
	result["status"] = pages.contains { !(($0["text"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) } ? "parsed" : "needs_ocr"
} else if data.starts(with: [0x50, 0x4b]), let office = inspectOffice(url: url, data: data) {
	result.merge(office) { _, new in new }
} else if let image = CGImageSourceCreateWithData(data as CFData, nil),
	let properties = CGImageSourceCopyPropertiesAtIndex(image, 0, nil) as? [CFString: Any],
	let width = properties[kCGImagePropertyPixelWidth] as? Int,
	let height = properties[kCGImagePropertyPixelHeight] as? Int {
	result["kind"] = "image"
	result["status"] = "metadata_only"
	result["width"] = width
	result["height"] = height
} else if let text = String(data: data, encoding: .utf8), !text.contains("\0") {
	result["kind"] = "text"
	result["status"] = "parsed"
	result["pages"] = [["page": 1, "text": wholeLines(text, limit: 1_000_000)]]
	result["truncated"] = text.count > 1_000_000
} else {
	result["kind"] = "file"
	result["status"] = "unsupported"
}
guard let encoded = try? JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]) else { exit(4) }
FileHandle.standardOutput.write(encoded)
