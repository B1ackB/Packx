import { sentenceChunks, sentenceRanges, type SentenceChunk } from "./knowledgeSentenceSupport";
import type { SourceDocument, TokenCount } from "./knowledgeChunkingSupport";

export const overlapVariants = [0, 32, 64] as const;
/** Prepend whole trailing sentences up to the token cap. Keep the base 500-character chunks unchanged.
 * No overlap across paragraphs/tables. This isolates overlap from different base boundary choices. */
export function overlapChunks(doc: SourceDocument, maxTokens: number, count: TokenCount): SentenceChunk[] {
	return sentenceChunks(doc, "sentence-500", count).map((chunk) => {
		if (!maxTokens || chunk.block.table) return chunk;
		const span = chunk.spans[0], unit = doc.units.find((u) => u.id === span.unitId)!;
		const preceding = sentenceRanges(unit, doc.manifest.language).filter((s) => s.end <= span.start);
		let start = span.start;
		for (const sentence of preceding.reverse()) {
			if (count(unit.text.slice(sentence.start, span.start).trim()) > maxTokens) break;
			start = sentence.start;
		}
		return { block: { ...chunk.block, text: unit.text.slice(start, span.end) }, spans: [{ ...span, start }] };
	});
}
