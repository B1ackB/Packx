import Foundation

// ZIP central-directory bounds are checked before any decompression. No archive extraction.
struct OfficeArchive {
	let url: URL
	let names: Set<String>
	init?(url: URL, data: Data) {
		func u16(_ p: Int) -> Int { Int(data[p]) | Int(data[p + 1]) << 8 }
		func u32(_ p: Int) -> Int { u16(p) | u16(p + 2) << 16 }
		guard data.count >= 22 else { return nil }
		guard let end = stride(from: data.count - 22, through: max(0, data.count - 65_557), by: -1).first(where: { u32($0) == 0x06054b50 && $0 + 22 + u16($0 + 20) == data.count }) else { return nil }
		guard u16(end + 4) == 0, u16(end + 6) == 0, u16(end + 8) == u16(end + 10), u16(end + 10) <= 2048 else { return nil }
		var offset = u32(end + 16)
		var total = 0
		var entries = Set<String>()
		for _ in 0..<u16(end + 10) {
			guard offset + 46 <= end, u32(offset) == 0x02014b50, u16(offset + 8) & 1 == 0 else { return nil }
			let size = u32(offset + 24)
			let length = u16(offset + 28)
			let next = offset + 46 + length + u16(offset + 30) + u16(offset + 32)
			total += size
			guard size <= 8_000_000, total <= 32_000_000, next <= end,
				let name = String(data: data[(offset + 46)..<(offset + 46 + length)], encoding: .utf8),
				!name.hasPrefix("/"), !name.split(separator: "/").contains(".."), !entries.contains(name) else { return nil }
			entries.insert(name); offset = next
		}
		guard offset == end else { return nil }
		self.url = url; self.names = entries
	}
	func part(_ name: String) -> Data? {
		guard names.contains(name), !name.contains("*"), !name.contains("?"), !name.contains("[") else { return nil }
		let process = Process(); let pipe = Pipe()
		process.executableURL = URL(fileURLWithPath: "/usr/bin/unzip")
		process.arguments = ["-p", url.path, name]
		process.standardOutput = pipe; process.standardError = FileHandle.standardError
		do { try process.run() } catch { return nil }
		var output = Data()
		while true {
			let chunk = pipe.fileHandleForReading.readData(ofLength: 65_536)
			if chunk.isEmpty { break }
			output.append(chunk)
			if output.count > 8_000_000 { process.terminate(); process.waitUntilExit(); return nil }
		}
		process.waitUntilExit()
		return process.terminationStatus == 0 ? output : nil
	}
}

final class OfficeXML: NSObject, XMLParserDelegate {
	var start: (String, [String: String]) -> Void = { _, _ in }
	var end: (String) -> Void = { _ in }
	var text: (String) -> Void = { _ in }
	func parse(_ data: Data?) -> Bool {
		guard let data, let raw = String(data: data, encoding: .utf8), !raw.contains("<!DOCTYPE"), !raw.contains("<!ENTITY") else { return false }
		let parser = XMLParser(data: data); parser.delegate = self; parser.shouldResolveExternalEntities = false
		return parser.parse()
	}
	func parser(_ parser: XMLParser, didStartElement name: String, namespaceURI: String?, qualifiedName: String?, attributes: [String: String]) { start(name.split(separator: ":").last.map(String.init) ?? name, attributes) }
	func parser(_ parser: XMLParser, didEndElement name: String, namespaceURI: String?, qualifiedName: String?) { end(name.split(separator: ":").last.map(String.init) ?? name) }
	func parser(_ parser: XMLParser, foundCharacters string: String) { text(string) }
}

func inspectOffice(url: URL, data: Data) -> [String: Any]? {
	guard let archive = OfficeArchive(url: url, data: data) else { return nil }
	if archive.names.contains("word/document.xml") {
		var output = ""; var inText = false; var inCell = false
		let xml = OfficeXML()
		xml.start = { name, _ in if name == "tc" { inCell = true }; if name == "t" { inText = true }; if name == "tab" { output += "\t" }; if name == "br" { output += "\n" } }
		xml.text = { if inText { output += $0 } }
		xml.end = { if $0 == "t" { inText = false }; if $0 == "p" { output += inCell ? " " : "\n" }; if $0 == "tc" { inCell = false; output += "\t" }; if $0 == "tr" { output += "\n" } }
		guard xml.parse(archive.part("word/document.xml")) else { return nil }
		for part in ["word/footnotes.xml", "word/endnotes.xml"] where archive.names.contains(part) {
			output += "\nSource notes: \(part)\n"
			let notes = OfficeXML()
			notes.start = { name, attrs in
				if name == "t" { inText = true }
				if name == "footnote" || name == "endnote" { output += "[note \(attrs["w:id"] ?? attrs["id"] ?? "?")] " }
			}
			notes.text = { if inText { output += $0 } }
			notes.end = { if $0 == "t" { inText = false }; if $0 == "p" { output += "\n" } }
			guard notes.parse(archive.part(part)) else { return nil }
		}
		return ["kind": "word", "status": "parsed", "pages": [["page": 1, "text": wholeLines(output, limit: 1_000_000)]], "truncated": output.count > 1_000_000]
	}
	if archive.names.contains("xl/workbook.xml") {
		var strings: [String] = []; var value = ""; var inText = false
		let shared = OfficeXML()
		shared.start = { name, _ in if name == "si" { value = "" }; if name == "t" { inText = true } }
		shared.text = { if inText { value += $0 } }
		shared.end = { if $0 == "t" { inText = false }; if $0 == "si" { strings.append(value) } }
		if archive.names.contains("xl/sharedStrings.xml") && !shared.parse(archive.part("xl/sharedStrings.xml")) { return nil }
		var relations: [String: String] = [:]
		let rel = OfficeXML()
		rel.start = { name, attrs in if name == "Relationship", attrs["TargetMode"] != "External", let id = attrs["Id"], let target = attrs["Target"], !target.contains(".."), !target.contains(":") { relations[id] = target.hasPrefix("/xl/") ? String(target.dropFirst()) : "xl/" + target } }
		guard rel.parse(archive.part("xl/_rels/workbook.xml.rels")) else { return nil }
		var sheets: [(String, String)] = []
		let book = OfficeXML()
		book.start = { name, attrs in if name == "sheet", let title = attrs["name"], let id = attrs["r:id"], let target = relations[id] { sheets.append((title, target)) } }
		guard book.parse(archive.part("xl/workbook.xml")), !sheets.isEmpty else { return nil }
		var pages: [[String: Any]] = []; var remaining = 1_000_000; var truncated = sheets.count > 1000
		for (title, target) in sheets.prefix(1000) {
			if remaining <= 0 { truncated = true; break }
			var output = "Sheet: \(title)\n"; var coordinate = ""; var type = ""; var cell = ""; var formula = false; var capture = false; var rowText = ""
			let sheet = OfficeXML()
			sheet.start = { name, attrs in
				if name == "row" { rowText = "" }
				if name == "c" { coordinate = attrs["r"] ?? "?"; type = attrs["t"] ?? "n"; cell = ""; formula = false }
				if name == "f" { formula = true }
				if name == "v" || name == "t" { capture = true }
			}
			sheet.text = { if capture { cell += $0 } }
			sheet.end = { name in
				if name == "v" || name == "t" { capture = false }
				if name == "c" {
					let text: String
					if type == "s", let index = Int(cell), strings.indices.contains(index) { text = strings[index] } else { text = cell }
					rowText += "\(coordinate): \(text.replacingOccurrences(of: "\n", with: " "))\(formula ? " [cached formula result; not recalculated]" : "")\t"
				}
				if name == "row" { output += rowText + "\n" }
			}
			guard sheet.parse(archive.part(target)) else { return nil }
			let bounded = wholeLines(output, limit: remaining); remaining -= bounded.count
			truncated = truncated || bounded.count < output.count
			pages.append(["page": pages.count + 1, "text": bounded])
		}
		return ["kind": "spreadsheet", "status": "parsed", "pages": pages, "truncated": truncated]
	}
	return nil
}
