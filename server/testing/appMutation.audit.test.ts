import { readFileSync } from "node:fs";
import ts from "typescript";
import { expect, it, vi } from "vitest";
import { ConversationClientError } from "../../src/runtime/conversationClient";

// Execute the real handlers with deferred HTTP responses; no DOM test dependency is needed.
const source = ts.createSourceFile("App.tsx", readFileSync("src/App.tsx", "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function handler(name: string, bindings: Record<string, unknown>) {
	let initializer: ts.Expression | undefined;
	const visit = (node: ts.Node) => {
		if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) initializer = node.initializer;
		ts.forEachChild(node, visit);
	};
	visit(source);
	if (!initializer) throw new Error(`Missing App handler ${name}`);
	const compiled = ts.transpileModule(`const handler = ${initializer.getText(source)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
	return new Function(...Object.keys(bindings), `${compiled}; return handler;`)(...Object.values(bindings)) as (...args: unknown[]) => Promise<void>;
}
function harness(name: string) {
	let resolve!: (value: unknown) => void, reject!: (reason: unknown) => void;
	const response = new Promise((yes, no) => { resolve = yes; reject = no; });
	const activeIdRef = { current: "A" }, activeGeneration = { current: 1 };
	const setRequirement = vi.fn(), setRequirementBusy = vi.fn(), setError = vi.fn();
	const setters = { setRequirement, setRequirementBusy, setError, setFactKey: vi.fn(), setFactValue: vi.fn(), setFactUnit: vi.fn(), setPanelTab: vi.fn(), setReviewOpen: vi.fn() };
	const client = { startRequirementBrief: vi.fn(() => response), resolveRequirementApproval: vi.fn(() => response), cancelRequirementBrief: vi.fn(() => response), recordRequirementFact: vi.fn(() => response), resolveRequirementFact: vi.fn(() => response), getRequirementBrief: vi.fn() };
	const invoke = handler(name, { active: { conversationId: "A" }, activeIdRef, activeGeneration, requirementBusy: false, sending: false, realProvider: true,
		requirement: { state: { aggregateVersion: 10, stageStatus: "needs_input", facts: { quantity: { version: 1 } }, approval: { status: "requested", approvalId: "approval-A", artifactVersion: 2 } } },
		factKey: "quantity", factValue: "5000", factUnit: "pcs", client, ...setters, ConversationClientError, errorMessage: String,
	});
	const run = () => name === "recordFact" ? invoke({ preventDefault() {} }) : name === "resolveFact" ? invoke("quantity", "verified") : name === "startRequirement" ? invoke() : invoke("approved");
	return { run, resolve, reject, setters, client, activeIdRef, activeGeneration };
}

it.each(["startRequirement", "resolveRequirementApproval", "cancelRequirement", "recordFact", "resolveFact"])("keeps %s responses, errors and busy state bound to the active selection", async name => {
	for (const target of ["A", "B"]) {
		const h = harness(name), pending = h.run();
		h.activeIdRef.current = target; h.activeGeneration.current += 2; // Includes A -> B -> A.
		Object.values(h.setters).forEach(mock => mock.mockClear());
		h.resolve({ runId: "requirement-A" }); await pending;
		for (const setter of Object.values(h.setters)) expect(setter).not.toHaveBeenCalled();
	}
	const failed = harness(name), pending = failed.run();
	failed.activeIdRef.current = "B"; failed.activeGeneration.current++;
	Object.values(failed.setters).forEach(mock => mock.mockClear());
	failed.reject(new Error("A failed")); await pending;
	for (const setter of Object.values(failed.setters)) expect(setter).not.toHaveBeenCalled();
	const current = harness(name), currentPending = current.run();
	current.resolve({ runId: "requirement-A" }); await currentPending;
	expect(current.setters.setRequirement).toHaveBeenCalledWith({ runId: "requirement-A" });
	expect(current.setters.setRequirementBusy).toHaveBeenLastCalledWith(false);
});

it.each([["resolveFact", "fact_review_stale"], ["resolveRequirementApproval", "approval_review_stale"]])("guards the second refresh after a %s conflict", async (name, code) => {
	const h = harness(name);
	let finish!: (value: unknown) => void;
	h.client.getRequirementBrief.mockReturnValue(new Promise(resolve => { finish = resolve; }));
	const pending = h.run(); h.reject(new ConversationClientError(code, "refresh required"));
	await vi.waitFor(() => expect(h.client.getRequirementBrief).toHaveBeenCalledWith("A"));
	h.activeIdRef.current = "B"; h.activeGeneration.current++;
	Object.values(h.setters).forEach(mock => mock.mockClear());
	finish({ runId: "requirement-A" }); await pending;
	for (const setter of Object.values(h.setters)) expect(setter).not.toHaveBeenCalled();
});
