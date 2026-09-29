/** Representation only. These rules never confirm a Fact or prove its source. */
export const requirementFieldProtocol = "packaging-field-representation.v2";
type FieldValue = { value: unknown; unit?: string };
type Comparison = { status: "equivalent" | "different" | "needs_review"; reason: string };
const text = (value: string) => value.normalize("NFKC").trim().replaceAll(/\s+/g, " ").toLowerCase();
const countUnits = new Set(["pcs", "个", "件", "只", "张"]);
function number(value: unknown): string | undefined {
	if (typeof value === "number" && (!Number.isFinite(value) || Number.isInteger(value) && !Number.isSafeInteger(value))) return undefined;
	if (typeof value !== "number" && typeof value !== "string") return undefined;
	const raw = String(value).trim();
	if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(raw)) return undefined;
	// Compare decimal strings without rounding untrusted decimal digits through Number().
	const normalized = raw.includes(".") ? raw.replace(/0+$/, "").replace(/\.$/, "") : raw;
	return normalized === "-0" ? "0" : normalized;
}
const aliases: Record<string, string[][]> = {
	target_market: [["香港", "中国香港", "Hong Kong"], ["中国内地", "中国大陆", "Mainland China"], ["新加坡", "Singapore"], ["日本", "Japan"], ["英国", "United Kingdom", "UK"]],
	artwork_status: [["定稿已提供", "已提供定稿"], ["设计中", "正在设计"], ["print artwork supplied, preflight pending", "印刷稿已提供，待印前检查", "已提供印刷稿，待印前检查"]],
};
function unit(key: string, value = "") {
	const normalized = text(value);
	if (key === "quantity" && countUnits.has(normalized)) return "pcs";
	if (["dimensions", "material_thickness"].includes(key) && normalized === "毫米") return "mm";
	return normalized;
}
function dimension(field: FieldValue) {
	let value = typeof field.value === "string" ? text(field.value).replaceAll(/[×＊*]/g, "x").replaceAll(/\s+/g, "") : field.value;
	let units = unit("dimensions", field.unit);
	const suffix = typeof value === "string" ? /(毫米|厘米|mm|cm)$/.exec(value) : null;
	if (suffix) {
		const embedded = suffix[1] === "毫米" ? "mm" : suffix[1] === "厘米" ? "cm" : suffix[1];
		if (units && units !== embedded) return { value, units, invalid: true };
		units = embedded;
		value = (value as string).slice(0, -suffix[1].length);
	}
	return { value, units, invalid: false };
}

export function compareRequirementField(key: string, actual: FieldValue, expected: FieldValue): Comparison {
	const same: Comparison = { status: "equivalent", reason: "same_representation" };
	const different = (reason: string): Comparison => ({ status: "different", reason });
	const review = (reason: string): Comparison => ({ status: "needs_review", reason });
	let left = actual.value, right = expected.value;
	let leftUnit = unit(key, actual.unit), rightUnit = unit(key, expected.unit);
	if (key === "dimensions") {
		const a = dimension(actual), b = dimension(expected);
		if (a.invalid || b.invalid) return different("conflicting_embedded_unit");
		left = a.value; right = b.value; leftUnit = a.units; rightUnit = b.units;
	}
	if (leftUnit !== rightUnit) return leftUnit && rightUnit ? different("unit_mismatch") : review("missing_unit");
	if (["quantity", "material_thickness"].includes(key)) {
		const a = number(left), b = number(right);
		if (a === undefined || b === undefined) return review("non_numeric_value");
		return a === b ? same : different("numeric_mismatch");
	}
	if (key === "target_delivery" && typeof left === "string" && typeof right === "string") {
		const a = /^(\d{4}-\d{2}-\d{2})(?:\s*(到货|出货))?$/.exec(text(left));
		const b = /^(\d{4}-\d{2}-\d{2})(?:\s*(到货|出货))?$/.exec(text(right));
		if (a && b) {
			if (a[1] !== b[1]) return different("date_mismatch");
			if (a[2] !== b[2]) return a[2] && b[2] ? different("delivery_basis_mismatch") : review("delivery_basis_requires_confirmation");
		}
	}
	if (typeof left === "string" && typeof right === "string") {
		const canonical = (value: string) => text(aliases[key]?.find((group) => group.some((alias) => text(alias) === text(value)))?.[0] ?? value);
		if (canonical(left) === canonical(right)) return same;
		if (key === "dimensions") {
			const numbers = (value: string) => value.match(/\d+(?:\.\d+)?/g) ?? [];
			if (JSON.stringify(numbers(left)) !== JSON.stringify(numbers(right))) return different("dimension_numbers_mismatch");
			if (/内/.test(left) && /外/.test(right) || /外/.test(left) && /内/.test(right)) return different("dimension_basis_mismatch");
		}
		return review("unlisted_wording");
	}
	return Object.is(left, right) ? same : different("value_mismatch");
}

export const requirementFieldInstructions = [
	`Field representation contract: ${requirementFieldProtocol}. Extract atomic values from original sources; preserve sourceRef and leave status unverified.`,
	"For quantity and material_thickness put only a numeric value in value and the explicitly supplied unit in unit. Never convert rolls or cartons to pieces without authoritative conversion data. For dimensions preserve axis order and inner/outer/diameter labels; keep the unit either in value or unit, consistently. Do not infer missing units.",
	"For target_delivery preserve the stated date AND arrival/shipping basis; an unspecified basis stays unspecified. For artwork_status retain the source's actual status, putting additional recommendations in assumptions without deleting source qualifications. Do not append general commentary to field values or invent missing information. Unknown wording remains subject to human confirmation.",
];
