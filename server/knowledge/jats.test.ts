import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { parseJats } from "./jats";
import { assertImport } from "./validation";
import { loadCoffeeCorpus, corpusRoot } from "../manufacturing/coffeeOpenCorpus";
import { compareParameters, coffeeEvidenceReview, normalizeParameter } from "../../src/manufacturing/packagingKnowledge";
import type { EvidenceHit } from "../../src/enterprise/knowledge";
import { digest } from "./store";
import { realKnowledgeCases } from "../../eval/knowledgeRealCases";

it("validates 5 licensed immutable snapshots and preserves section-only locations", () => {
	const corpus = loadCoffeeCorpus(); expect(corpus).toHaveLength(5);
	expect(corpus.reduce((n, d) => n + d.blocks.length, 0)).toBe(568);
	for (const d of corpus) { expect(() => assertImport(d)).not.toThrow(); expect(d.permission.basis).toContain("CC BY 4.0"); expect(d.model).toBe(`study:${d.documentId}`); }
	expect(corpus[1].blocks[17].location).toMatchObject({ anchor: "sec2dot2-foods-13-00759", paragraph: 5 });
	expect(corpus[1].blocks[17].location.page).toBeUndefined();
	expect(corpus[0].blocks[36].location.page).toBe(13);
});
it("preserves multirow headers, rows, uncertainty, compound units and complete footnotes", () => {
	const corpus = loadCoffeeCorpus();
	const t = corpus[0].blocks[48].table!;
	expect(t.headers).toEqual(["Time (Months)", "25 °C / STD", "25 °C / REC", "40 °C / STD", "40 °C / REC"]);
	expect(t.rows[0][1]).toBe("1.15 ± 0.09"); expect(t.footnotes[0]).toContain("No statistically significant differences");
	const p = corpus[4].blocks[75]; expect(p.table!.headers[3]).toBe("OTR [cm3 mm/(m2·d·0.1 MPa)]"); expect(p.table!.rows).toEqual([["PLA-C3", "2.61", "1.40", "7"]]);
	expect(corpus[2].blocks[52].table!.footnotes[0].length).toBeGreaterThan(500);
});
it("rejects entity expansion, malformed XML and a noncommercial licence", () => {
	const xml = readFileSync(resolve(corpusRoot, "PMC11243642.1/PMC11243642.1.xml"), "utf8");
	expect(() => parseJats(xml.replaceAll("/licenses/by/4.0/", "/licenses/by-nc-nd/4.0/"))).toThrow("jats_license_not_cc_by_4");
	expect(() => parseJats('<!DOCTYPE x [<!ENTITY x SYSTEM "file:///etc/passwd">]><x>&x;</x>')).toThrow("jats_unsafe_xml");
	expect(() => parseJats("<article><body></article>")).toThrow("jats_invalid_xml");
});
it("freezes 64 provisional questions and verifies their source spans without claiming human gold", () => {
	expect(digest(realKnowledgeCases)).toBe(digest(JSON.parse(readFileSync(resolve(corpusRoot, "questions.v1.json"), "utf8"))));
	const corpus = loadCoffeeCorpus();
	for (const c of realKnowledgeCases) for (const e of c.expected) expect(JSON.stringify(corpus.find((d) => d.documentId === e.documentId)!.blocks[e.block - 1])).toContain(e.quote);
	expect(realKnowledgeCases.every((c) => c.labelStatus === "agent_source_checked_pending_human_review")).toBe(true);
});
it("does not turn an inequality, range or uncertainty into a scalar and asks for missing conditions", () => {
	const corpus = loadCoffeeCorpus(), a = corpus[0].blocks[35], b = corpus[0].blocks[36];
	expect(compareParameters(a.parameters[0], b.parameters[0])).toMatchObject({ comparable: false });
	expect(normalizeParameter(b.parameters[2]).normalized).toEqual({ value: 15, unit: "µm" });
	for (const p of [a.parameters[0], corpus[2].blocks[50].parameters[1], corpus[3].blocks[63].parameters[0]]) expect(normalizeParameter(p).normalized).toBeUndefined();
	const review = coffeeEvidenceReview([{ ...b, model: "study:PMC11243642", evidenceId: "test" } as EvidenceHit]);
	expect(review.questions.some((q) => q.includes("原始单位"))).toBe(true);
	expect(review.questions.some((q) => q.includes("测试方法"))).toBe(true);
	expect(review.questions.some((q) => q.includes("温度、湿度"))).toBe(true);
});
