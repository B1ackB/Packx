import { crc32, inflateRawSync, deflateRawSync } from "node:zlib";
import { XMLParser, XMLValidator } from "fast-xml-parser";

export class OfficeTemplateError extends Error {}
const fail = (message = "模板损坏或格式不支持") => { throw new OfficeTemplateError(message); };
const decoder = new TextDecoder("utf-8", { fatal: true });
const xmlText = new XMLParser({ parseTagValue: false, trimValues: false });
const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

/** Bounded ZIP adapter. No filesystem extraction, URLs, scripts or Office automation. */
export function readOfficeZip(data: Buffer): Map<string, Buffer> {
	if (data.length < 22 || data.length > 5 * 1024 * 1024) fail("模板应为 5 MiB 以内的 DOCX/XLSX");
	let end = data.length - 22;
	while (end >= Math.max(0, data.length - 65557) && (data.readUInt32LE(end) !== 0x06054b50 || end + 22 + data.readUInt16LE(end + 20) !== data.length)) end--;
	if (end < 0 || data.readUInt32LE(end) !== 0x06054b50) fail();
	const count = data.readUInt16LE(end + 10);
	if (data.readUInt32LE(end + 4) !== 0 || count !== data.readUInt16LE(end + 8) || count > 512) fail();
	let offset = data.readUInt32LE(end + 16); const start = offset;
	let total = 0; const entries = new Map<string, Buffer>();
	for (let i = 0; i < count; i++) {
		if (offset + 46 > end || data.readUInt32LE(offset) !== 0x02014b50) fail();
		const flags = data.readUInt16LE(offset + 8), method = data.readUInt16LE(offset + 10);
		const compressed = data.readUInt32LE(offset + 20), size = data.readUInt32LE(offset + 24), length = data.readUInt16LE(offset + 28);
		const next = offset + 46 + length + data.readUInt16LE(offset + 30) + data.readUInt16LE(offset + 32);
		const local = data.readUInt32LE(offset + 42);
		total += size;
		if ((flags & ~0x808) !== 0 || ![0, 8].includes(method) || size > 4_000_000 || total > 20_000_000 || next > end || local + 30 > start) fail("模板归档超限或不支持加密");
		const name = decoder.decode(data.subarray(offset + 46, offset + 46 + length));
		if (!/^[A-Za-z0-9_./\[\]-]+$/.test(name) || name.startsWith("/") || name.split("/").some((part) => part === ".." || part === ".") || entries.has(name)) fail();
		if (data.readUInt32LE(local) !== 0x04034b50 || data.readUInt16LE(local + 8) !== method || data.readUInt16LE(local + 6) !== flags) fail();
		const body = local + 30 + data.readUInt16LE(local + 26) + data.readUInt16LE(local + 28);
		if (body + compressed > start || decoder.decode(data.subarray(local + 30, local + 30 + data.readUInt16LE(local + 26))) !== name) fail();
		const input = data.subarray(body, body + compressed);
		const output = method === 0 ? input : inflateRawSync(input, { maxOutputLength: Math.max(1, size) });
		if (output.length !== size || crc32(output) !== data.readUInt32LE(offset + 16)) fail();
		entries.set(name, output); offset = next;
	}
	if (offset !== end || offset - start !== data.readUInt32LE(end + 12)) fail();
	return entries;
}

export function writeOfficeZip(entries: Map<string, Buffer>): Buffer {
	const local: Buffer[] = [], central: Buffer[] = []; let offset = 0;
	for (const [name, data] of entries) {
		const filename = Buffer.from(name), compressed = deflateRawSync(data), crc = crc32(data);
		const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(8, 8);
		header.writeUInt32LE(crc, 14); header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(filename.length, 26);
		const directory = Buffer.alloc(46); directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(8, 10);
		directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(compressed.length, 20); directory.writeUInt32LE(data.length, 24); directory.writeUInt16LE(filename.length, 28); directory.writeUInt32LE(offset, 42);
		local.push(header, filename, compressed); central.push(directory, filename); offset += header.length + filename.length + compressed.length;
	}
	const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.size, 8); end.writeUInt16LE(entries.size, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
	return Buffer.concat([...local, directory, end]);
}

export interface TemplateSlot { key: string; location: string; context: string }
export interface OfficeTemplate { format: "docx" | "xlsx"; slots: TemplateSlot[]; entries: Map<string, Buffer> }
const token = /\{\{([A-Za-z][A-Za-z0-9_]{0,63})\}\}/g;

function textNodes(block: string) {
	return [...block.matchAll(/<((?:[A-Za-z_][\w.-]*:)?(?:t|v))(?:\s[^>]*)?>([^<]*)<\/\1>/g)].map((match) => ({ raw: match[0], index: match.index!, text: String(xmlText.parse(`<value>${match[2]}</value>`).value ?? ""), tag: match[1] }));
}
function transformBlock(block: string, replace?: Record<string, string>): string {
	const nodes = textNodes(block); const text = nodes.map((node) => node.text).join("");
	if (!replace) return text;
	const texts = nodes.map((node) => node.text);
	for (const match of [...text.matchAll(token)].reverse()) {
		let start = 0;
		for (let i = 0; i < nodes.length; i++) {
			const end = start + nodes[i].text.length, from = match.index!, to = from + match[0].length;
			if (start < to && end > from) texts[i] = texts[i].slice(0, Math.max(0, from - start)) + (from >= start ? replace[match[1]] : "") + texts[i].slice(Math.min(nodes[i].text.length, to - start));
			start = end;
		}
	}
	for (let i = nodes.length - 1; i >= 0; i--) block = block.slice(0, nodes[i].index) + `<${nodes[i].tag} xml:space="preserve">${escape(texts[i])}</${nodes[i].tag}>` + block.slice(nodes[i].index + nodes[i].raw.length);
	return block;
}

export function inspectTemplate(data: Buffer, name: string): OfficeTemplate {
	try {
		const entries = readOfficeZip(data);
		const format = /\.docx$/i.test(name) && entries.has("word/document.xml") ? "docx" : /\.xlsx$/i.test(name) && entries.has("xl/workbook.xml") ? "xlsx" : fail("仅支持 DOCX 或 XLSX 模板，请先转换旧版文件");
		if (!entries.has("[Content_Types].xml")) fail();
		const slots: TemplateSlot[] = [];
		for (const [part, bytes] of entries) {
			if (/vba|activeX|embeddings|externalLinks|connections|queryTables|_xmlsignatures/i.test(part)) fail("模板包含宏、嵌入对象、外部数据或签名，请移除后上传");
			if (!/\.(xml|rels)$/.test(part)) continue;
			const xml = decoder.decode(bytes);
			const normalized = xml.replace(/&#(x[0-9a-f]+|[0-9]+);/gi, (_, code: string) => String.fromCodePoint(code[0].toLowerCase() === "x" ? parseInt(code.slice(1), 16) : Number(code)));
			if (/TargetMode\s*=\s*["']External["']|macroEnabled|vbaProject|oleObject|attachedTemplate|<(?:[A-Za-z_][\w.-]*:)?(?:object|altChunk|control|dataBinding|fldChar)\b/i.test(normalized)) fail("模板包含外部引用或主动内容");
			if (/<!DOCTYPE|<!ENTITY|TargetMode\s*=\s*["']External["']|macroEnabled|<(?:[A-Za-z_][\w.-]*:)?(?:instrText|fldSimple)\b/i.test(xml) || XMLValidator.validate(xml) !== true) fail("模板不能包含外部链接、域、宏或无效 XML");
			if (/<(?:\w+:)?(?:definedNames|dataValidations|conditionalFormatting)\b/.test(xml)) fail("首版模板不支持命名公式、数据验证或条件格式，请移除后导入");
			for (const formula of xml.matchAll(/<(?:\w+:)?f([^>]*)>([^<]*)<\/(?:\w+:)?f>/g)) {
				const expression = String(xmlText.parse(`<value>${formula[2]}</value>`).value ?? "");
				if (formula[1].trim() || !expression || expression.length > 1024 || !/^[A-Z0-9$:+*/().,%\s-]+$/i.test(expression) || expression.replace(/\b(?:SUM|MIN|MAX|COUNT|AVERAGE|ROUND|ABS)\s*(?=\()/gi, "").replace(/\$?[A-Z]{1,3}\$?[1-9][0-9]{0,6}/g, "").match(/[A-Z]/i)) fail("仅支持同工作表内部算术及 SUM/MIN/MAX/COUNT/AVERAGE/ROUND/ABS；不执行公式，请在 Excel 重算");
			}
			if (/<(?:\w+:)?f\b[^>]*\/>/.test(xml)) fail("暂不支持共享或数组公式");
			let index = 0;
			const blocks = format === "docx" && /^word\/(document|header\d+|footer\d+)\.xml$/.test(part) ? /<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g : format === "xlsx" && /^xl\/(sharedStrings|worksheets\/sheet\d+)\.xml$/.test(part) ? /<((?:[A-Za-z_][\w.-]*:)?(?:si|c))(?![^>]*\/>)(?:\s[^>]*)?>[\s\S]*?<\/\1>/g : null;
			if (!blocks) { if (xml.includes("{{")) fail("占位符仅支持正文、页眉页脚、表格或文本单元格"); continue; }
			for (const block of xml.matchAll(blocks)) {
				index++; const text = transformBlock(block[0]);
				if (/\{\{|\}\}/.test(text.replace(token, ""))) fail("占位符需为 {{field_name}}，且不能跨段落或单元格");
				for (const match of text.matchAll(token)) slots.push({ key: match[1], location: `${part}#${format === "docx" ? "paragraph" : "item"}=${index}${/\br="([^"]+)"/.exec(block[0])?.[1] ? ` (${/\br="([^"]+)"/.exec(block[0])![1]})` : ""}`, context: text.slice(0, 240) });
			}
		}
		if (!slots.length || slots.length > 128) fail("模板需包含 1–128 个 {{field_name}} 占位符");
		return { entries, format, slots };
	} catch (error) { if (error instanceof OfficeTemplateError) throw error; return fail(); }
}

export function fillTemplate(template: OfficeTemplate, values: Record<string, string>): Buffer {
	for (const slot of template.slots) if (!Object.hasOwn(values, slot.key) || values[slot.key].length > 4096 || /[\x00-\x08\x0b\x0c\x0e-\x1f]|\{\{|\}\}/.test(values[slot.key])) fail("字段缺少映射或内容超限");
	const entries = new Map(template.entries);
	for (const [part, data] of entries) {
		const blocks = template.format === "docx" && /^word\/(document|header\d+|footer\d+)\.xml$/.test(part) ? /<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g : template.format === "xlsx" && /^xl\/(sharedStrings|worksheets\/sheet\d+)\.xml$/.test(part) ? /<((?:[A-Za-z_][\w.-]*:)?(?:si|c))(?![^>]*\/>)(?:\s[^>]*)?>[\s\S]*?<\/\1>/g : null;
		if (blocks) entries.set(part, Buffer.from(data.toString("utf8").replace(blocks, (block) => {
			let output = transformBlock(block, values);
			if (template.format === "xlsx" && /<(?:\w+:)?f[\s>]/.test(output)) output = output.replace(/<(?:\w+:)?v(?:\s[^>]*)?>[^<]*<\/(?:\w+:)?v>/g, "");
			return output;
		})));
		if (template.format === "xlsx" && part === "xl/workbook.xml") entries.set(part, Buffer.from(data.toString("utf8").replace(/<(?:\w+:)?calcPr\b[^>]*\/>/g, "").replace(/<\/((?:\w+:)?)workbook>/, '<$1calcPr calcMode="auto" fullCalcOnLoad="1" forceFullCalc="1"/></$1workbook>')));
	}
	const output = writeOfficeZip(entries);
	if (output.length > 5 * 1024 * 1024) fail("生成文件超过 5 MiB");
	return output;
}
