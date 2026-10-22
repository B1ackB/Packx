import { createHash } from "node:crypto";
import { PLAN_LIMITS, PlanError, type PlanInputDependencies } from "../../src/enterprise/agentPlan";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Capture only Host task-context inputs. New downstream records are not retroactive dependencies. */
export function planInputDependencies(context: string, selected?: PlanInputDependencies): PlanInputDependencies | undefined {
	let value;
	try { value = JSON.parse(context); } catch { return undefined; }
	if (value?.schemaVersion !== "task-context.v1") return undefined;
	if (![value.facts, value.artifacts, value.unresolved].every(Array.isArray)) throw new PlanError("plan_input_dependencies_invalid", 422);
	const collect = <K extends "key" | "artifactId">(records: Array<Record<string, unknown>>, identity: K, required?: Array<Record<K, string>>) => {
		const seen = new Set<string>();
		return records.flatMap(item => {
			if (!item || typeof item !== "object" || Array.isArray(item) || typeof item[identity] !== "string" || !item[identity].trim() || item[identity].length > 128 || seen.has(item[identity]) || !Number.isSafeInteger(item.version) || Number(item.version) < 1) throw new PlanError("plan_input_dependencies_invalid", 422);
			seen.add(item[identity]);
			return required && !required.some(entry => entry[identity] === item[identity]) ? [] : [{ [identity]: item[identity], version: Number(item.version), sha256: digest(item) } as Record<K, string> & { version: number; sha256: string }];
		}).sort((a, b) => a[identity].localeCompare(b[identity]));
	};
	const facts = collect(value.facts, "key", selected?.facts);
	const artifacts = collect(value.artifacts, "artifactId", selected?.artifacts);
	if (facts.length + artifacts.length > PLAN_LIMITS.inputRecords) throw new PlanError("plan_input_dependencies_invalid", 422);
	const basis = { ...value };
	for (const key of ["facts", "artifacts", "stage", "completed", "pendingChanges", "approval"]) delete basis[key];
	basis.unresolved = value.unresolved.filter((item: { reason?: string } | null) => item?.reason === "source_unavailable");
	return { schemaVersion: "plan-input-dependencies.v1", contextSha256: digest(basis), facts, artifacts };
}
