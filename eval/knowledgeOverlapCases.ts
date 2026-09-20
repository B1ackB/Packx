import assert from "node:assert/strict";
import type { ChunkCase, SourceDocument } from "./knowledgeChunkingSupport";

/** Source-checked provisional labels, fixed before the first V3 retrieval. No model answers as gold. */
export function supplementCases(docs: SourceDocument[]): ChunkCase[] {
	const specs = [
		{ id: "poly-storage", doc: "PMC12607991", section: "Abstract", quote: "40, 50 and 60 °C", bundle: "The samples were stored at 40, 50 and 60 °C for 12, 8 and 4 days, respectively.", zh: "精品咖啡多酚降解研究的加速储存温度与各自天数是什么？", en: "In the specialty coffee polyphenol degradation study, which storage temperatures correspond to which durations?" },
		{ id: "poly-evoh", doc: "PMC12607991", section: "2. Materials and Methods / 2.1. Materials", quote: "EVOH", bundle: "for roasted coffee beans in vacuum-packed in Ecotac bags (High barrier laminated plastic structure with EVOH (Eth-ylene-Vinyl-Alcohol) layer and dimensions of 20 × 30 cm)", zh: "多酚降解研究中，烘焙咖啡豆的 Ecotac 真空袋注明了什么阻隔层及实验袋尺寸？", en: "Which barrier layer and experimental bag dimensions are stated for Ecotac vacuum-packed roasted beans in the polyphenol study?" },
		{ id: "poly-fill", doc: "PMC12607991", section: "2. Materials and Methods / 2.1. Materials", quote: "250 g", bundle: "Each container held 250 g of sample.", zh: "多酚降解研究中每个容器装入多少样品？只查询实验装量。", en: "What sample mass did each container hold in the polyphenol degradation study?" },
		{ id: "poly-table", doc: "PMC12607991", section: "Table 1", row: 1, quote: "107.87± 0.01 a", zh: "多酚研究表1中，40°C、0天时 BTCV 包装研磨咖啡的多酚数值和单位是什么？", en: "In Table 1 of the polyphenol study, what value and unit are reported for BTCV ground roast at day zero and 40 °C?" },
		{ id: "instant-open", doc: "PMC12111376", section: "2. Materials and Methods / 2.2. Coffee Sample Preparation", quote: "removed from the original packaging", bundle: "Instant coffee powder from the same production batch was removed from the original packaging and stored under different controlled environmental conditions.", zh: "速溶咖啡环境湿度研究的试验样品留在原包装里还是取出后测试？", en: "In the instant-coffee humidity study, were samples tested inside their original commercial packaging or removed from it?" },
		{ id: "instant-conditions", doc: "PMC12111376", section: "2. Materials and Methods / 2.2. Coffee Sample Preparation", quote: "20 °C", bundle: "The sample was distributed to form a homogeneous layer of 5-mm thickness, and stored at 20 °C at three different environmental relative humidities, or ERH (%), i.e., 11, 32, and 65%.", zh: "速溶咖啡吸湿研究的样品层厚度、储存温度和三档相对湿度是什么？", en: "What sample layer thickness, storage temperature and three ERH levels were used in the instant coffee humidity study?" },
		{ id: "instant-table", doc: "PMC12111376", section: "Table 1", row: 3, quote: "0.15 ± 0.01", zh: "速溶咖啡吸湿论文表1在65% ERH时的拟合速率k及单位是什么？", en: "What fitted moisture uptake rate k and unit does Table 1 give for instant coffee at 65% ERH?" },
		{ id: "instant-method", doc: "PMC12111376", section: "2. Materials and Methods / 2.3. Moisture of Instant Coffee Powder", quote: "75 °C", bundle: "In particular, 1 g of the instant coffee powder was dried at 75 °C and 1.32 kPa for 12 h using a vacuum oven (Vuotomatic 50, Bicasa, Milan, Italy).", zh: "速溶咖啡湿度研究中，测含水率时真空烘干的质量、温度、压力和时长分别是什么？", en: "For gravimetric moisture measurement in the instant coffee study, what sample mass, temperature, pressure and drying time were used?" },
	];
	return specs.flatMap((spec) => {
		const doc = docs.find((d) => d.manifest.documentId === spec.doc)!;
		const u = doc.units.find((u) => u.location.section === spec.section && (spec.row === undefined || u.location.row === spec.row) && u.text.includes(spec.quote)); assert(u);
		const body = spec.bundle ?? u.text, start = u.text.indexOf(body); assert(start >= 0, spec.id);
		const offset = u.text.indexOf(spec.quote, start); assert(offset >= start && offset + spec.quote.length <= start + body.length, spec.id);
		return (["zh", "en"] as const).map((language) => ({ id: `${spec.id}-${language}`, query: spec[language], language, split: "frozen" as const, category: spec.row ? "table_parameter" : "test_conditions", family: doc.manifest.family, labelStatus: "agent_source_checked_pending_human_review" as const,
			expected: [{ documentId: spec.doc, quote: spec.quote, location: u.location, anchor: { unitId: u.id, start: offset, end: offset + spec.quote.length }, bundle: [{ unitId: u.id, start, end: start + body.length }] }] }));
	});
}
