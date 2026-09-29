import { expect, it } from "vitest";
import { compareRequirementField } from "./requirementField";

it.each([
	["quantity", { value: "3600.00", unit: "个" }, { value: 3600, unit: "pcs" }],
	["dimensions", { value: "外径90×高135", unit: "毫米" }, { value: "外径 90 * 高 135 mm" }],
	["target_market", { value: "Hong Kong" }, { value: "中国香港" }],
	["artwork_status", { value: "已提供定稿" }, { value: "定稿已提供" }],
] as const)("recognizes bounded representations of %s", (key, actual, expected) => {
	expect(compareRequirementField(key, actual, expected).status).toBe("equivalent");
});

it.each([
	["quantity", { value: "5201", unit: "pcs" }, { value: 5101, unit: "pcs" }, "numeric_mismatch"],
	["quantity", { value: 3600, unit: "卷" }, { value: 3600, unit: "pcs" }, "unit_mismatch"],
	["dimensions", { value: "90x135mm", unit: "cm" }, { value: "90x135mm" }, "conflicting_embedded_unit"],
	["dimensions", { value: "135x90mm" }, { value: "90x135mm" }, "dimension_numbers_mismatch"],
	["dimensions", { value: "内径90x高135mm" }, { value: "外径90x高135mm" }, "dimension_basis_mismatch"],
	["target_delivery", { value: "2026-10-15 到货" }, { value: "2026-10-15 出货" }, "delivery_basis_mismatch"],
	["target_delivery", { value: "2026-10-16" }, { value: "2026-10-15" }, "date_mismatch"],
	["quantity", { value: "9007199254740993", unit: "pcs" }, { value: "9007199254740992", unit: "pcs" }, "numeric_mismatch"],
	["material_thickness", { value: "0.060000000000000000001", unit: "mm" }, { value: 0.06, unit: "mm" }, "numeric_mismatch"],
] as const)("rejects a known %s conflict (%s)", (key, actual, expected, reason) => {
	expect(compareRequirementField(key, actual, expected)).toEqual({ status: "different", reason });
});

it.each([
	["quantity", { value: "3600 pcs" }, { value: 3600, unit: "pcs" }],
	["target_delivery", { value: "2026-10-15 到货" }, { value: "2026-10-15" }],
	["artwork_status", { value: "定稿已提供，仍需客户确认" }, { value: "定稿已提供" }],
	["artwork_status", { value: "定稿已提供，待印前检查" }, { value: "定稿已提供" }],
	["product_type", { value: "瓶贴" }, { value: "瓶身标签" }],
	["delivery_location", { value: "香港" }, { value: "中国香港" }],
] as const)("keeps unresolved %s semantics for explicit review", (key, actual, expected) => {
	expect(compareRequirementField(key, actual, expected).status).toBe("needs_review");
});
