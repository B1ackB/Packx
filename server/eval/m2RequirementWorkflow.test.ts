import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runM2RequirementWorkflow } from "./m2RequirementWorkflow";

const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("M2 Requirement Brief workflow baseline", () => {
	it("runs all 10 fixed tasks through Queue, Product Worker, ArtifactVersion, Evaluation, and Approval Gate", async () => {
		const directory = mkdtempSync(join(tmpdir(), "blackx-m2-requirement-test-"));
		directories.push(directory);
		const report = await runM2RequirementWorkflow(directory);

		expect(report).toMatchObject({
			contract: "blackx-m2-packaging-workflow-baseline-v3",
			passed: true,
			fixtures: 10,
			approvalEligible: 4,
			industries: { print: 10 },
		});
		expect(report.results).toHaveLength(10);
		expect(report.results.every((result) => result.toolReadSucceeded)).toBe(true);
		expect(report.results.every((result) => result.toolExecutions === 1 && result.toolFailures === 0)).toBe(true);
		expect(report.results.every((result) => result.artifactMatched)).toBe(true);
		expect(report.results.filter((result) => result.finalStageStatus === "passed")).toHaveLength(4);
		expect(report.results.filter((result) => result.finalStageStatus === "needs_input")).toHaveLength(6);
		expect(report.results.every((result) =>
			result.events.includes("artifact.version_created") && result.events.includes("evaluation.completed"),
		)).toBe(true);
	}, 15_000);
});
