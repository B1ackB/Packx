import type { EvidenceReviewReport } from "../enterprise/evidenceReview";

export type ManufacturingIndustry = "print";

export type RequirementFactStatus = "suggested" | "unverified" | "verified";

export type RequirementFactSourceType =
	| "user_input"
	| "source_document"
	| "enterprise_source"
	| "human_confirmation"
	| "model_output";

export interface RequirementFactV1 {
	key: string;
	version: number;
	value: string | number | boolean;
	unit?: string;
	status: RequirementFactStatus;
	sourceType: RequirementFactSourceType;
	sourceRef: string;
}

export interface RequirementBriefV1 {
	schemaVersion: "requirement-brief.v1";
	industry: ManufacturingIndustry;
	title: string;
	customerGoal: string;
	facts: RequirementFactV1[];
	missingRequiredFacts: string[];
	assumptions: string[];
	/** Host-owned proposals; they never replace the current confirmed Fact. */
	pendingChanges?: RequirementFactChange[];
	nextAction: "clarify" | "confirm_facts" | "ready_for_approval";
}

export interface RequirementFactChange {
	key: string;
	currentFactVersion: number;
	value: string | number | boolean;
	unit?: string;
	sourceRef: string;
}

export function pendingChangeNotes(facts: RequirementFactV1[], changes: RequirementFactChange[]): string[] {
	return changes.flatMap((change) => {
		const current = facts.find((fact) => fact.key === change.key);
		return current ? [`${change.key}：已确认 ${current.value}${current.unit ? ` ${current.unit}` : ""}；新提议 ${change.value}${change.unit ? ` ${change.unit}` : ""}（来源 ${change.sourceRef}），待人工确认。旧交付物不能继续作为当前完整交接依据。`] : [];
	});
}

export interface RequirementBriefEvaluation {
	schemaVersion: "requirement-brief-evaluation.v1";
	evidenceReview?: EvidenceReviewReport;
	decision?: "continue" | "revise" | "request_input" | "reconfirm_plan";
	passed: boolean;
	approvalEligible: boolean;
	issues: Array<{ code: string; message: string }>;
}

export const requiredRequirementFacts: Record<ManufacturingIndustry, readonly string[]> = {
	print: [
		"product_type",
		"quantity",
		"dimensions",
		"target_market",
		"target_delivery",
		"delivery_location",
		"artwork_status",
	],
};

const requirementFactAliases: Record<ManufacturingIndustry, Record<string, string>> = {
	print: {
		packaging_type: "product_type",
		package_type: "product_type",
		bag_type: "product_type",
		order_quantity: "quantity",
		quantity_reference: "quantity",
		size: "dimensions",
		measurements: "dimensions",
		market: "target_market",
		destination_market: "target_market",
		delivery_date: "target_delivery",
		deadline: "target_delivery",
		ship_to: "delivery_location",
		destination: "delivery_location",
		artwork: "artwork_status",
		design_status: "artwork_status",
	},
};

// Optional intake details; absence never implies a production specification.
export const optionalPackagingFacts = ["material_structure", "material_thickness", "printing_process", "surface_finish", "closure_type", "valve_requirement"] as const;
export const packagingFactKeys: readonly string[] = [...requiredRequirementFacts.print, ...optionalPackagingFacts];

export function normalizeRequirementFactKey(
	industry: ManufacturingIndustry,
	key: string,
): string | undefined {
	const normalized = key.trim().toLowerCase().replaceAll(/[^a-z0-9]+/g, "_").replaceAll(/^_+|_+$/g, "");
	if (packagingFactKeys.includes(normalized)) return normalized;
	return requirementFactAliases[industry][normalized];
}

const canonicalRequirementFactKeys = packagingFactKeys;

// Domain-owned questions survive model revisions; they never supply missing values.
const requiredClarifications: Record<string, string> = {
	product_type: "请确认本单包装类型及用途。",
	quantity: "请确认本单总数量及计数单位；若按卷或箱下单，请提供每卷/箱数量或总件数，不按常见规格估算。",
	dimensions: "请提供本单完整尺寸和单位，并说明内尺寸或外尺寸口径；袋型请包含宽、高、底折，其他类型请给出适用的长宽高或直径；也可提供本单可读图纸。",
	target_market: "请确认本单销售市场；送货地址不能代替销售市场。",
	target_delivery: "请确认本单要求的交付日期及到货或出货口径。",
	delivery_location: "请确认本单实际送货地点。",
	artwork_status: "请确认稿件状态：尚未设计、设计中或已提供；若需要厂方协助设计，请一并说明。",
};
const standardClarifications = new Set(Object.values(requiredClarifications));

export const requirementBriefOutputSchema = {
	type: "object",
	properties: {
		schemaVersion: { const: "requirement-brief.v1" },
		industry: { enum: ["print"] },
		title: { type: "string", minLength: 1 },
		customerGoal: { type: "string", minLength: 1 },
		facts: {
			type: "array",
			items: {
				type: "object",
				properties: {
					key: { enum: canonicalRequirementFactKeys },
					version: { type: "integer", minimum: 1 },
					value: { type: ["string", "number", "boolean"] },
					unit: { type: "string" },
					status: { enum: ["suggested", "unverified", "verified"] },
					sourceType: {
						enum: ["user_input", "source_document", "enterprise_source", "human_confirmation", "model_output"],
					},
					sourceRef: { type: "string", minLength: 1 },
				},
				required: ["key", "version", "value", "status", "sourceType", "sourceRef"],
				additionalProperties: false,
			},
		},
		missingRequiredFacts: { type: "array", items: { type: "string", minLength: 1 } },
		assumptions: { type: "array", items: { type: "string", minLength: 1 } },
		nextAction: { enum: ["clarify", "confirm_facts", "ready_for_approval"] },
	},
	required: [
		"schemaVersion",
		"industry",
		"title",
		"customerGoal",
		"facts",
		"missingRequiredFacts",
		"assumptions",
		"nextAction",
	],
	additionalProperties: false,
} as const;

export function createRequirementBrief(input: {
	industry: ManufacturingIndustry;
	title: string;
	customerGoal: string;
	facts: RequirementFactV1[];
	assumptions?: string[];
	pendingChanges?: RequirementFactChange[];
}): RequirementBriefV1 {
	const required = requiredRequirementFacts[input.industry];
	const facts = input.facts
		.filter((fact) => fact.key !== "industry" && fact.key !== "customer_brief")
		.map(({ unit, ...fact }) => unit === undefined ? fact : { ...fact, unit });
	const missingRequiredFacts = required.filter((key) => !facts.some((fact) => fact.key === key));
	const hasUnverifiedRequired = facts.some(
		(fact) => fact.status !== "verified",
	);
	return {
		schemaVersion: "requirement-brief.v1",
		industry: input.industry,
		title: input.title.trim() || "Customer Requirement Brief",
		customerGoal: input.customerGoal.trim() || "Clarify the customer's packaging requirement",
		facts,
		...(input.pendingChanges?.length ? { pendingChanges: input.pendingChanges.map((change) => ({ ...change })) } : {}),
		missingRequiredFacts,
		assumptions: [...new Set([
			...(input.assumptions ?? []).map((value) => value.trim()).filter((value) => value && !standardClarifications.has(value)),
			...missingRequiredFacts.map((key) => requiredClarifications[key]),
			...pendingChangeNotes(facts, input.pendingChanges ?? []),
		])],
		nextAction: missingRequiredFacts.length > 0
			? "clarify"
			: hasUnverifiedRequired || Boolean(input.pendingChanges?.length)
				? "confirm_facts"
				: "ready_for_approval",
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sameMembers(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value) => right.includes(value));
}

const factSourceTypes = new Set<RequirementFactSourceType>([
	"user_input",
	"source_document",
	"enterprise_source",
	"human_confirmation",
	"model_output",
]);

const briefKeys = new Set([
	"schemaVersion",
	"industry",
	"title",
	"customerGoal",
	"facts",
	"missingRequiredFacts",
	"assumptions",
	"nextAction",
	"pendingChanges",
]);

const allowedFactKeys = new Set(["key", "version", "value", "unit", "status", "sourceType", "sourceRef"]);

export function evaluateRequirementBrief(value: unknown): RequirementBriefEvaluation {
	const issues: RequirementBriefEvaluation["issues"] = [];
	const issue = (code: string, message: string) => issues.push({ code, message });
	if (!isRecord(value) || value.schemaVersion !== "requirement-brief.v1") {
		return {
			schemaVersion: "requirement-brief-evaluation.v1",
			passed: false,
			approvalEligible: false,
			issues: [{ code: "invalid_schema", message: "Requirement Brief schemaVersion is invalid" }],
		};
	}
	if (Object.keys(value).some((key) => !briefKeys.has(key))) {
		issue("unexpected_field", "Requirement Brief contains an unexpected field");
	}
	const industry = value.industry === "print"
		? value.industry
		: undefined;
	if (!industry) issue("invalid_industry", "Only packaging requirements (print) are supported");
	if (typeof value.title !== "string" || !value.title.trim()) {
		issue("missing_title", "Requirement Brief title is required");
	}
	if (typeof value.customerGoal !== "string" || !value.customerGoal.trim()) {
		issue("missing_customer_goal", "Customer goal is required");
	}
	if (!Array.isArray(value.facts)) issue("invalid_facts", "Facts must be an array");
	const facts = Array.isArray(value.facts)
		? value.facts.filter(isRecord)
		: [];
	if (Array.isArray(value.facts) && facts.length !== value.facts.length) {
		issue("invalid_fact", "Every Fact must be an object");
	}
	const observedFactKeys: string[] = [];
	for (const fact of facts) {
		if (Object.keys(fact).some((candidate) => !allowedFactKeys.has(candidate))) {
			issue("unexpected_fact_field", "A Fact contains an unexpected field");
		}
		const key = typeof fact.key === "string" ? fact.key.trim() : "";
		if (!/^[a-z][a-z0-9_]{0,63}$/.test(key)) issue("invalid_fact_key", "Every Fact requires a stable key");
		else if (observedFactKeys.includes(key)) issue("duplicate_fact", `Fact ${key} is duplicated`);
		else observedFactKeys.push(key);
		if (!Number.isInteger(fact.version) || Number(fact.version) < 1) {
			issue("invalid_fact_version", `Fact ${key || "unknown"} has an invalid version`);
		}
		if (
			(typeof fact.value !== "string" && typeof fact.value !== "number" && typeof fact.value !== "boolean") ||
			typeof fact.value === "string" && !fact.value.trim() ||
			typeof fact.value === "number" && !Number.isFinite(fact.value)
		) issue("invalid_fact_value", `Fact ${key || "unknown"} has an invalid value`);
		if (
			fact.status !== "suggested" &&
			fact.status !== "unverified" &&
			fact.status !== "verified"
		) issue("invalid_fact_status", `Fact ${key || "unknown"} has an invalid status`);
		if (!factSourceTypes.has(fact.sourceType as RequirementFactSourceType)) {
			issue("invalid_source_type", `Fact ${key || "unknown"} has an invalid source type`);
		}
		if (fact.unit !== undefined && (typeof fact.unit !== "string" || !fact.unit.trim())) {
			issue("invalid_fact_unit", `Fact ${key || "unknown"} has an invalid unit`);
		}
		if (typeof fact.sourceRef !== "string" || !fact.sourceRef.trim()) {
			issue("missing_source", `Fact ${key || "unknown"} has no source reference`);
		}
		if (
			fact.status === "verified" &&
			fact.sourceType !== "enterprise_source" &&
			fact.sourceType !== "human_confirmation"
		) issue("invalid_authority", `Verified Fact ${key || "unknown"} lacks an authoritative source`);
	}

	const required = industry ? requiredRequirementFacts[industry] : [];
	if (industry) {
		for (const key of observedFactKeys) {
			if (!packagingFactKeys.includes(key)) issue("unsupported_fact", `Fact ${key} is not canonical for ${industry}`);
		}
	}
	const missing = required.filter((key) => !observedFactKeys.includes(key));
	const declaredMissing = Array.isArray(value.missingRequiredFacts)
		? value.missingRequiredFacts.filter((key): key is string => typeof key === "string")
		: [];
	if (
		!Array.isArray(value.missingRequiredFacts) ||
		declaredMissing.length !== value.missingRequiredFacts.length ||
		new Set(declaredMissing).size !== declaredMissing.length ||
		!sameMembers(missing, declaredMissing)
	) {
		issue("missing_fact_mismatch", "missingRequiredFacts does not match the actual required Fact gap");
	}
	if (!Array.isArray(value.assumptions) || value.assumptions.some(
		(assumption) => typeof assumption !== "string" || !assumption.trim(),
	)) issue("invalid_assumptions", "Assumptions must be non-empty strings");

	const unverifiedRequired = facts.filter(
		(fact) => fact.status !== "verified",
	);
	const changes = Array.isArray(value.pendingChanges) ? value.pendingChanges : [];
	if (value.pendingChanges !== undefined && (!Array.isArray(value.pendingChanges) || changes.length > 30)) issue("invalid_pending_changes", "Pending changes must be a bounded array");
	for (const change of changes) {
		const current = isRecord(change) ? facts.find((fact) => fact.key === change.key) : undefined;
		if (!isRecord(change) || Object.keys(change).some((key) => !["key", "currentFactVersion", "value", "unit", "sourceRef"].includes(key)) ||
			!current || current.status !== "verified" || change.currentFactVersion !== current.version ||
			!["string", "number", "boolean"].includes(typeof change.value) || typeof change.value === "number" && !Number.isFinite(change.value) ||
			typeof change.value === "string" && !change.value.trim() || typeof change.sourceRef !== "string" || !change.sourceRef.trim() ||
			change.unit !== undefined && (typeof change.unit !== "string" || !change.unit.trim())) issue("invalid_pending_change", "A pending change must bind the current confirmed Fact and its proposal source");
	}
	const expectedNextAction = missing.length > 0
		? "clarify"
		: unverifiedRequired.length > 0 || changes.length > 0
			? "confirm_facts"
			: "ready_for_approval";
	if (value.nextAction !== expectedNextAction) {
		issue("invalid_next_action", `nextAction must be ${expectedNextAction}`);
	}
	const passed = issues.length === 0;
	return {
		schemaVersion: "requirement-brief-evaluation.v1",
		passed,
		approvalEligible: passed && expectedNextAction === "ready_for_approval",
		issues,
	};
}
