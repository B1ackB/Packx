import { strict as assert } from "node:assert";
import { readFileSync, writeFileSync } from "node:fs";
import { digest } from "../server/knowledge/store";
import { loadCoffeeCorpus } from "../server/manufacturing/coffeeOpenCorpus";
import { sourceDocuments, coverage, mean, type Span, type ChunkCase } from "./knowledgeChunkingSupport";

// Post-hoc diagnostics only. Do not modify the preregistered metrics or select a production policy here.
const report = JSON.parse(readFileSync("docs/evidence/knowledge-chunking-v1.json", "utf8")) as {
	protocolHash: string;
	runs: Array<{ variant: string; index: { documents: Array<{ event: { usage: { inputTokens: number; forwardPasses: number; modelDurationMs: number } } }> }; modes: Array<{ mode: string; rows: Row[] }> }>;
};
interface Row {
	id: string; budget: { complete: number; recall: number } | null;
	selected: string[]; skipped: string[]; hits: Array<{ id: string; spans: Span[] }>;
}
const cases = JSON.parse(readFileSync("data/knowledge/chunking-v1/cases.json", "utf8")) as ChunkCase[];
const texts = new Map(sourceDocuments(loadCoffeeCorpus()).flatMap((d) => d.units.map((u) => [u.id, u.text] as const)));
function nonWhitespace(spans: Span[]) {
	return spans.flatMap((s) => Array.from(texts.get(s.unitId)!.slice(s.start, s.end).matchAll(/\S+/g), (m) => ({ unitId: s.unitId, start: s.start + m.index, end: s.start + m.index + m[0].length })));
}
const baseline = report.runs[0].modes.find((m) => m.mode === "hybrid")!.rows;
const analyses = report.runs.map((run) => {
	const rows = run.modes.find((m) => m.mode === "hybrid")!.rows;
	const paired = rows.filter((r) => r.budget).map((r) => {
		const before = baseline.find((b) => b.id === r.id)!;
		const item = cases.find((c) => c.id === r.id)!;
		const spans = r.hits.filter((h) => r.selected.includes(h.id)).flatMap((h) => h.spans);
		const relaxed = mean(item.expected.map((e) => Number(coverage(nonWhitespace(e.bundle), spans) === 1)))!;
		const anyRetrieved = item.expected.every((e) => coverage([e.anchor], r.hits.flatMap((h) => h.spans)) === 1);
		const quote = item.expected.every((e) => coverage([e.anchor], spans) === 1);
		const chunkHasBundle = item.expected.every((e) => r.hits.some((h) => coverage(e.bundle, h.spans) === 1));
		return { id: r.id, language: item.language, family: item.family, table: item.expected.some((e) => e.location.table), before: before.budget!.complete, after: r.budget!.complete, delta: r.budget!.complete - before.budget!.complete,
			whitespaceRelaxed: relaxed, failure: r.budget!.complete === 1 ? null : !anyRetrieved ? "missing_from_top8" : !quote ? "anchor_lost_to_budget" : !chunkHasBundle ? "context_split_across_chunks" : "context_lost_to_budget", selected: r.selected };
	});
	const groups = [...new Set(paired.map((r) => r.id.replace(/-(zh|en)$/, "")))].map((id) => ({ id, meanDelta: mean(paired.filter((r) => r.id.replace(/-(zh|en)$/, "") === id).map((r) => r.delta))! }));
	const usage = run.index.documents.map((d) => d.event.usage);
	return { variant: run.variant, indexUsage: { inputTokens: usage.reduce((n, u) => n + u.inputTokens, 0), forwardPasses: usage.reduce((n, u) => n + u.forwardPasses, 0), modelDurationMs: usage.reduce((n, u) => n + u.modelDurationMs, 0) },
		pairedQueries: { win: paired.filter((r) => r.delta > 0).length, loss: paired.filter((r) => r.delta < 0).length, tie: paired.filter((r) => r.delta === 0).length },
		bilingualGroups: { count: groups.length, win: groups.filter((g) => g.meanDelta > 0).length, loss: groups.filter((g) => g.meanDelta < 0).length, tie: groups.filter((g) => g.meanDelta === 0).length, groups },
		whitespaceSensitivity: { changes: paired.filter((r) => r.whitespaceRelaxed !== r.after).map((r) => r.id), relaxedComplete: mean(paired.map((r) => r.whitespaceRelaxed)) }, paired };
});
assert(analyses.every((a) => a.pairedQueries.win + a.pairedQueries.loss + a.pairedQueries.tie === 56));
const result = { schemaVersion: "knowledge-chunking-analysis.v1", analyzedAt: new Date().toISOString(), protocolHash: report.protocolHash, reportHash: digest(report), analysisSourceHash: digest(readFileSync("eval/knowledgeChunkingAnalysis.ts", "utf8")),
	description: "Post-hoc paired failure analysis and whitespace sensitivity. Primary preregistered results unchanged. Bilingual pairs are grouped; only four paper families, no significance/generalization claim.", analyses };
writeFileSync("docs/evidence/knowledge-chunking-analysis-v1.json", JSON.stringify(result, null, "\t") + "\n");
console.log(JSON.stringify(analyses.map(({ paired: _paired, bilingualGroups: { groups: _groups, ...bilingualGroups }, ...rest }) => ({ ...rest, bilingualGroups })), null, "\t"));
