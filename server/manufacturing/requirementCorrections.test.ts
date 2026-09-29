import { expect, it } from "vitest";
import type { FactVersionState } from "../../src/enterprise/contracts";
import type { RequirementFactV1 } from "../../src/manufacturing/requirementBrief";
import { correctExtractedQuantity, originalCustomerText } from "./requirementCorrections";

const fact: RequirementFactV1 = { key: "quantity", value: 12500, unit: "pcs", status: "unverified", sourceType: "model_output", sourceRef: "customer-1", version: 1 };
const source = (text = "咖啡豆平底袋 12000 个，材料结构与厚度暂不确定。", ref = "customer-1") => ({ ref, version: 1, content: { sourceRef: ref, representation: "authored_text", content: text } });
const correct = (text: string) => correctExtractedQuantity(fact, fact, [source(text)], "咖啡豆平底袋");

it.each(["咖啡豆平底袋 12000 个，材料结构与厚度暂不确定。", "订单数量：12000 个。", "数量: 12000 pcs"])("corrects a single explicit original quantity without confirming it: %s", text => {
	const result = correct(text)!;
	expect(result.fact).toEqual({ ...fact, value: 12000 });
	expect(result.audit).toMatchObject({ previousValue: 12500, value: 12000, sourceRef: "customer-1", sourceVersion: 1, quote: text, previousFactVersion: 1, status: "unverified" });
	expect(fact.value).toBe(12500);
});

it.each([
	"数量：大约 12000 个。", "数量：12000 个左右。", "数量：12000 个起。", "至少 12000 个。",
	"数量：10000 至 12000 个。", "数量：12000 个或 12500 个。", "数量：12000 个，另加 500 个。",
	"每箱 12000 个。", "样品 12000 个。", "数量：12000 个/箱。", "数量：12,000 个。",
	"旧订单 12000 个。", "不要 12000 个。", "数量：12000 个，等负责人批准。", "数量：12000 个，可能修改。",
	"追加数量：12000 个。", "改为 12000 个。", "数量：12000 卷。", "数量：12000 个，另外 30 箱。",
	"报价按 12000 个计算。", "计划数量：12000 个。", "数量：12000。", "数量：12000.5 个。",
])("does not infer a total or a customer decision: %s", text => {
	expect(correct(text)).toBeUndefined();
});

it("requires current source identity, matching units and agreement across originals", () => {
	expect(correctExtractedQuantity(fact, fact, [source(), source("数量：13000 个。", "customer-2")], "咖啡豆平底袋")).toBeUndefined();
	expect(correctExtractedQuantity(fact, fact, [source(), source("追加 30 卷。", "customer-2")], "咖啡豆平底袋")).toBeUndefined();
	expect(correctExtractedQuantity(fact, fact, [source(), source()], "咖啡豆平底袋")).toBeUndefined();
	expect(correctExtractedQuantity(fact, fact, [source(), source("数量：一万三千个。", "customer-2")], "咖啡豆平底袋")).toBeUndefined();
	expect(correctExtractedQuantity(fact, fact, [source(), { ref: "attachment://other#page=1", version: 1, content: { page: 1, text: "数量：13000 个" } }], "咖啡豆平底袋")).toBeUndefined();
	expect(correctExtractedQuantity({ ...fact, unit: "卷" }, fact, [source()], "咖啡豆平底袋")).toBeUndefined();
	expect(correctExtractedQuantity({ ...fact, sourceRef: "other-tenant" }, fact, [source()], "咖啡豆平底袋")).toBeUndefined();
	expect(correctExtractedQuantity(fact, { ...fact, sourceRef: "another-version" }, [source()], "咖啡豆平底袋")).toBeUndefined();
});

it.each([
	{ status: "verified" }, { status: "rejected" }, { sourceType: "human_confirmation" }, { sourceType: "user_input" },
])("never overwrites confirmed, withdrawn or human-edited state: %s", patch => {
	expect(correctExtractedQuantity(fact, { ...fact, ...patch } as FactVersionState, [source()], "咖啡豆平底袋")).toBeUndefined();
});

it.each([{ representation: "metadata_only" }, { representation: "model_summary" }, { status: "unreadable" }, { status: "withdrawn" }, { status: "rejected" }, { truncated: true }, { excerptOnly: true }, { sourceType: "model_output" }])("does not treat unavailable or derived content as original text: %s", patch => {
	const evidence = { ...source(), content: { ...source().content, ...patch } };
	expect(originalCustomerText(evidence)).toBeUndefined();
	expect(correctExtractedQuantity(fact, fact, [evidence], "咖啡豆平底袋")).toBeUndefined();
});
