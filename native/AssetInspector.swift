import Foundation
import PDFKit
import ImageIO
import Darwin
import Vision

func hasRasterContent(_ page: PDFPage) -> Bool {
	guard let ref = page.pageRef, var dictionary = ref.dictionary else { return true }
	var resources: CGPDFDictionaryRef?; var objects: CGPDFDictionaryRef?
	// PDF resources may be inherited from the page tree, including mixed text/image pages.
	for _ in 0..<32 {
		if CGPDFDictionaryGetDictionary(dictionary, "Resources", &resources) { break }
		var parent: CGPDFDictionaryRef?
		guard CGPDFDictionaryGetDictionary(dictionary, "Parent", &parent), let parent else { break }
		dictionary = parent
	}
	guard let resources,
		CGPDFDictionaryGetDictionary(resources, "XObject", &objects), let objects else { return false }
	var found = false
	CGPDFDictionaryApplyFunction(objects, { _, object, info in
		var stream: CGPDFStreamRef?
		if CGPDFObjectGetValue(object, .stream, &stream), let stream {
			var subtype: UnsafePointer<CChar>?
			if let dictionary = CGPDFStreamGetDictionary(stream), CGPDFDictionaryGetName(dictionary, "Subtype", &subtype), let subtype,
				["Image", "Form"].contains(String(cString: subtype)) { info!.assumingMemoryBound(to: Bool.self).pointee = true }
		}
	}, &found)
	return found
}

// Rasterize one bounded page at a time. OCR is an observation, never a verified Fact.
func inspectPDFPage(_ page: PDFPage, number: Int) -> [String: Any] {
	let original = page.string ?? ""
	var result: [String: Any] = ["page": number, "text": original, "method": "text", "warnings": []]
	let bounds = page.bounds(for: .mediaBox)
	guard bounds.width.isFinite, bounds.height.isFinite, bounds.width > 0, bounds.height > 0 else {
		result["warnings"] = ["invalid_page_bounds"]; return result
	}
	let scale = min(2.5, 2400 / max(bounds.width, bounds.height))
	let width = max(1, Int(bounds.width * scale)); let height = max(1, Int(bounds.height * scale))
	guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
		result["warnings"] = ["page_render_failed"]; return result
	}
	context.setFillColor(CGColor(gray: 1, alpha: 1)); context.fill(CGRect(x: 0, y: 0, width: width, height: height))
	context.scaleBy(x: scale, y: scale); context.translateBy(x: -bounds.minX, y: -bounds.minY)
	page.draw(with: .mediaBox, to: context)
	guard let image = context.makeImage() else { result["warnings"] = ["page_render_failed"]; return result }
	let request = VNRecognizeTextRequest()
	request.recognitionLevel = .accurate; request.usesLanguageCorrection = false
	request.recognitionLanguages = ["zh-Hans", "zh-Hant", "en-US"]
	request.usesCPUOnly = true
	do {
		try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
		let observations = (request.results ?? []).compactMap { $0.topCandidates(1).first }
		// Retain native text verbatim; append only OCR lines absent from the text layer.
		let normalize: (String) -> String = { $0.filter { !$0.isWhitespace }.lowercased() }
		let native = normalize(original)
		let extra = observations.filter { !native.contains(normalize($0.string)) }
		let scanned = original.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
		let used = scanned ? observations : extra
		if !used.isEmpty {
			result["text"] = original + (scanned ? "" : "\n[OCR supplemental text — verify against original]\n") + used.map { $0.string }.joined(separator: "\n")
			result["method"] = scanned ? "ocr" : "text+ocr"
			result["confidence"] = Double(used.map { $0.confidence }.min() ?? 0)
			result["warnings"] = ["ocr_requires_review", "layout_not_preserved"] + (scanned ? [] : ["ocr_supplement_may_conflict"]) + (used.contains { $0.confidence < 0.8 } ? ["low_ocr_confidence"] : [])
		} else if scanned { result["method"] = "ocr"; result["warnings"] = ["no_text_recognized"] }
	} catch { result["warnings"] = ["ocr_failed"] }
	return result
}

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
var cpuLimit = rlimit(rlim_cur: 28, rlim_max: 28)
guard setrlimit(RLIMIT_CPU, &cpuLimit) == 0, (2...3).contains(CommandLine.arguments.count) else { exit(2) }
let url = URL(fileURLWithPath: CommandLine.arguments[1])
guard let data = try? Data(contentsOf: url), !data.isEmpty, data.count <= 10 * 1024 * 1024 else { exit(2) }
var result: [String: Any] = ["schemaVersion": "asset-inspection.v1", "bytes": data.count, "pages": [], "truncated": false]
if data.starts(with: Data("%PDF-".utf8)) {
	guard let document = PDFDocument(data: data), !document.isLocked, document.pageCount > 0 else { exit(3) }
	var pages: [[String: Any]] = []
	var remaining = 1_000_000
	var truncated = document.pageCount > 1000
	let deadline = Date().addingTimeInterval(18)
	let ocrStart = CommandLine.arguments.count == 3 ? max(1, Int(CommandLine.arguments[2]) ?? 1) : 1
	var ocrCount = 0; var nextPage: Int?
	for index in 0..<min(document.pageCount, 1000) {
		guard remaining > 0 else { truncated = true; break }
		guard let page = document.page(at: index) else { truncated = true; break }
		let native = page.string ?? ""
		var observation: [String: Any] = ["page": index + 1, "text": native, "method": "text", "warnings": []]
		if hasRasterContent(page) || native.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
			if index + 1 >= ocrStart && ocrCount < 12 && Date() < deadline {
				observation = autoreleasepool { inspectPDFPage(page, number: index + 1) }; ocrCount += 1
			} else {
				observation["warnings"] = ["ocr_pending"]
				if index + 1 >= ocrStart && nextPage == nil { nextPage = index + 1 }
			}
		}
		let text = observation["text"] as? String ?? ""
		let bounded = wholeLines(text, limit: remaining)
		if bounded.count < text.count { truncated = true }
		remaining -= bounded.count
		observation["text"] = bounded
		pages.append(observation)
	}
	if let nextPage { result["ocrNextPage"] = nextPage }
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
