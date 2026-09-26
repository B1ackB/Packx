import type {
	ManufacturingIndustry,
	RequirementBriefV1,
	RequirementFactV1,
} from "./requirementBrief";

export interface RequirementBriefFixture {
	fixtureId: string;
	industry: ManufacturingIndustry;
	input: string;
	expectedApprovalEligible: boolean;
	artifact: RequirementBriefV1;
}

function verified(
	key: string,
	value: RequirementFactV1["value"],
	unit?: string,
): RequirementFactV1 {
	return {
		key,
		version: 1,
		value,
		...(unit ? { unit } : {}),
		status: "verified",
		sourceType: "human_confirmation",
		sourceRef: `confirmation:${key}:v1`,
	};
}

function unverified(fact: RequirementFactV1): RequirementFactV1 {
	return {
		...fact,
		status: "unverified",
		sourceType: "user_input",
		sourceRef: `message:${fact.key}:v1`,
	};
}

const printFacts = [
	verified("product_type", "咖啡豆自立拉链袋"),
	verified("quantity", 10_000, "pcs"),
	verified("dimensions", "160 × 230 + 80 mm"),
	verified("target_market", "香港"),
	verified("target_delivery", "2026-11-30"),
	verified("delivery_location", "Hong Kong"),
	verified("artwork_status", "品牌稿件待提供"),
];



function without(facts: RequirementFactV1[], key: string): RequirementFactV1[] {
	return facts.filter((fact) => fact.key !== key);
}

function replace(
	facts: RequirementFactV1[],
	key: string,
	change: (fact: RequirementFactV1) => RequirementFactV1,
): RequirementFactV1[] {
	return facts.map((fact) => fact.key === key ? change(fact) : fact);
}

function values(
	facts: RequirementFactV1[],
	changes: Record<string, RequirementFactV1["value"]>,
): RequirementFactV1[] {
	return facts.map((fact) => fact.key in changes
		? { ...fact, value: changes[fact.key]! }
		: fact);
}

function brief(input: {
	industry: ManufacturingIndustry;
	title: string;
	goal: string;
	facts: RequirementFactV1[];
	missing?: string[];
	nextAction?: RequirementBriefV1["nextAction"];
}): RequirementBriefV1 {
	return {
		schemaVersion: "requirement-brief.v1",
		industry: input.industry,
		title: input.title,
		customerGoal: input.goal,
		facts: input.facts,
		missingRequiredFacts: input.missing ?? [],
		assumptions: (input.missing ?? []).map((key) => ({
			dimensions: "请提供本单完整尺寸和单位，并说明内尺寸或外尺寸口径；袋型请包含宽、高、底折，其他类型请给出适用的长宽高或直径；也可提供本单可读图纸。",
			artwork_status: "请确认稿件状态：尚未设计、设计中或已提供；若需要厂方协助设计，请一并说明。",
			delivery_location: "请确认本单实际送货地点。",
		} as Record<string, string>)[key]!),
		nextAction: input.nextAction ?? "ready_for_approval",
	};
}

export const requirementBriefFixtures: RequirementBriefFixture[] = [
	{
		fixtureId: "print-coffee-pouch-ready",
		industry: "print",
		input: "香港市场咖啡豆自立袋，1 万个，尺寸 160 × 230 + 80 mm，11 月底交付，稿件稍后提供。",
		expectedApprovalEligible: true,
		artifact: brief({
			industry: "print",
			title: "咖啡豆自立袋需求单",
			goal: "形成可交给包装工程师评估的已确认需求",
			facts: printFacts,
		}),
	},
	{
		fixtureId: "print-cosmetic-carton-missing-dimensions",
		industry: "print",
		input: "5000 个香港市场护肤品折叠纸盒，尺寸还没有确定，12 月交付。",
		expectedApprovalEligible: false,
		artifact: brief({
			industry: "print",
			title: "护肤品折叠纸盒需求单",
			goal: "确认报价和结构设计所需输入",
			facts: without(values(printFacts, {
				product_type: "护肤品折叠纸盒",
				quantity: 5_000,
				target_delivery: "2026-12-15",
			}), "dimensions"),
			missing: ["dimensions"],
			nextAction: "clarify",
		}),
	},
	{
		fixtureId: "print-label-unverified-market",
		industry: "print",
		input: "先做一批产品标签，市场可能是香港，请整理需求。",
		expectedApprovalEligible: false,
		artifact: brief({
			industry: "print",
			title: "产品标签需求单",
			goal: "冻结标签项目输入",
			facts: replace(values(printFacts, {
				product_type: "产品标签",
				quantity: 20_000,
				dimensions: "80 × 50 mm",
			}), "target_market", unverified),
			nextAction: "confirm_facts",
		}),
	},
	{
		fixtureId: "print-gift-box-ready",
		industry: "print",
		input: "礼品包装盒 2000 个，300 × 200 × 100 mm，香港交货，全部需求已确认。",
		expectedApprovalEligible: true,
		artifact: brief({
			industry: "print",
			title: "礼品包装盒需求单",
			goal: "交付印刷工程和报价评估",
			facts: values(printFacts, {
				product_type: "礼品包装盒",
				quantity: 2_000,
				dimensions: "300 × 200 × 100 mm",
				artwork_status: "定稿已提供",
			}),
		}),
	},
	{
		fixtureId: "print-mailer-missing-artwork",
		industry: "print",
		input: "电商快递纸箱需要月底前到货，但还没有确认稿件状态。",
		expectedApprovalEligible: false,
		artifact: brief({
			industry: "print",
			title: "电商快递纸箱需求单",
			goal: "确认运输包装输入",
			facts: without(values(printFacts, {
				product_type: "电商快递纸箱",
				quantity: 100,
				dimensions: "350 × 250 × 180 mm",
				target_delivery: "2026-09-30",
			}), "artwork_status"),
			missing: ["artwork_status"],
			nextAction: "clarify",
		}),
	},
	{
		fixtureId: "print-tea-tin-ready", industry: "print", expectedApprovalEligible: true,
		input: "茶叶包装罐 3000 个，直径 85 × 高 130 mm，香港交货，设计稿已定稿。",
		artifact: brief({ industry: "print", title: "茶叶包装罐需求单", goal: "确认茶叶包装采购输入", facts: values(printFacts, { product_type: "茶叶包装罐", quantity: 3000, dimensions: "直径 85 × 高 130 mm", artwork_status: "定稿已提供" }) }),
	},
	{
		fixtureId: "print-food-pouch-missing-artwork", industry: "print", expectedApprovalEligible: false,
		input: "需要 8000 个零食自立袋，稿件状态尚未确认。",
		artifact: brief({ industry: "print", title: "零食自立袋需求单", goal: "补齐包装印刷输入", facts: without(values(printFacts, { product_type: "零食自立袋", quantity: 8000 }), "artwork_status"), missing: ["artwork_status"], nextAction: "clarify" }),
	},
	{
		fixtureId: "print-shopping-bag-unverified-quantity", industry: "print", expectedApprovalEligible: false,
		input: "定制品牌手提纸袋，数量暂估 2000 个。",
		artifact: brief({ industry: "print", title: "品牌手提纸袋需求单", goal: "确认包装采购数量", facts: replace(values(printFacts, { product_type: "品牌手提纸袋", quantity: 2000, dimensions: "250 × 100 × 320 mm" }), "quantity", unverified), nextAction: "confirm_facts" }),
	},
	{
		fixtureId: "print-bottle-label-ready", industry: "print", expectedApprovalEligible: true,
		input: "饮料瓶包装标签 50000 张，80 × 50 mm，香港销售，稿件和交付要求已确认。",
		artifact: brief({ industry: "print", title: "饮料瓶包装标签需求单", goal: "交付标签包装评估", facts: values(printFacts, { product_type: "饮料瓶包装标签", quantity: 50000, dimensions: "80 × 50 mm", artwork_status: "定稿已提供" }) }),
	},
	{
		fixtureId: "print-corrugated-box-missing-location", industry: "print", expectedApprovalEligible: false,
		input: "瓦楞运输纸箱 1000 个，具体交货地点待客户确认。",
		artifact: brief({ industry: "print", title: "瓦楞运输纸箱需求单", goal: "补齐包装物流输入", facts: without(values(printFacts, { product_type: "瓦楞运输纸箱", quantity: 1000, dimensions: "400 × 300 × 250 mm" }), "delivery_location"), missing: ["delivery_location"], nextAction: "clarify" }),
	},
];
