import { describe, expect, it } from "vitest";
import { EnterpriseKernelError } from "./contracts";
import { InMemoryEnterpriseEventStore } from "./inMemoryEventStore";
import { ProposalRunEngine } from "./proposalRunEngine";

const scope = {
	tenantId: "tenant-a",
	workspaceId: "workspace-a",
	runId: "run-1",
};

function harness() {
	let id = 0;
	const store = new InMemoryEnterpriseEventStore({
		now: () => new Date("2026-09-01T00:00:00.000Z"),
		nextId: () => `event-${++id}`,
	});
	return { store, engine: new ProposalRunEngine(store) };
}

function command(commandId: string, expectedVersion: number) {
	return {
		...scope,
		commandId,
		correlationId: "trace-1",
		actorId: "user-1",
		expectedVersion,
	};
}

function prepareProposal(engine: ProposalRunEngine) {
	engine.create(command("create", 0));
	engine.startProposal(command("start", 1));
	return engine.completeProposal({
		...command("complete-proposal-v1", 2),
		runtime: {
			executionId: "runtime-1",
			adapterId: "fake-runtime",
			resumeHandle: "opaque-thread-1",
		},
		artifact: {
			artifactId: "solution-proposal",
			schemaVersion: "solution-proposal.v1",
			contentRef: "memory://proposal/v1",
			inputFactVersions: { quantity: 1, contents: 1 },
		},
		evaluation: {
			passed: true,
			reportRef: "memory://evaluation/v1",
		},
		approvalId: "approval-a-v1",
	});
}

describe("ProposalRunEngine", () => {
	it("completes the first Artifact-first approval path", () => {
		const { engine, store } = harness();
		const waiting = prepareProposal(engine);

		expect(waiting.status).toBe("waiting_approval");
		expect(waiting.stageStatus).toBe("waiting_approval");
		expect(waiting.currentProposal).toMatchObject({
			artifactId: "solution-proposal",
			version: 1,
			freshness: "fresh",
			runtimeExecutionId: "runtime-1",
		});
		expect(waiting.approval).toMatchObject({
			artifactVersion: 1,
			status: "requested",
		});

		const approved = engine.resolveApproval({
			...command("approve-v1", waiting.aggregateVersion),
			approvalId: "approval-a-v1",
			artifactId: "solution-proposal",
			artifactVersion: 1,
			decision: "approved",
		});
		expect(approved.status).toBe("waiting_approval");
		expect(approved.stageStatus).toBe("waiting_approval");

		const completed = engine.confirmProposalGate(
			command("confirm-gate-v1", approved.aggregateVersion),
		);

		expect(completed.status).toBe("completed");
		expect(completed.stageStatus).toBe("passed");
		expect(completed.approval?.status).toBe("approved");
		expect(store.read(scope).map((event) => event.data.type)).toEqual([
			"run.created",
			"stage.started",
			"runtime.execution.linked",
			"artifact.version_created",
			"evaluation.completed",
			"approval.requested",
			"approval.resolved",
			"stage.completed",
		]);
	});

	it("rejects approval for a different Artifact version", () => {
		const { engine } = harness();
		const waiting = prepareProposal(engine);

		expect(() => engine.resolveApproval({
			...command("approve-wrong-version", waiting.aggregateVersion),
			approvalId: "approval-a-v1",
			artifactId: "solution-proposal",
			artifactVersion: 2,
			decision: "approved",
		})).toThrowError(expect.objectContaining({
			code: "artifact_version_mismatch",
		}) as Partial<EnterpriseKernelError>);
	});

	it("marks the Proposal stale and supersedes its approval when an input Fact changes", () => {
		const { engine } = harness();
		const waiting = prepareProposal(engine);
		const approved = engine.resolveApproval({
			...command("approve-v1", waiting.aggregateVersion),
			approvalId: "approval-a-v1",
			artifactId: "solution-proposal",
			artifactVersion: 1,
			decision: "approved",
		});

		const stale = engine.recordFactVersion({
			...command("quantity-v2", approved.aggregateVersion),
			factKey: "quantity",
			factVersion: 2,
			value: 20_000,
			unit: "bags",
			status: "unverified",
			sourceType: "user_input",
			sourceRef: "message-quantity-v2",
		});

		expect(stale.status).toBe("revision_required");
		expect(stale.stageStatus).toBe("revision_required");
		expect(stale.currentProposal?.freshness).toBe("stale");
		expect(stale.approval?.status).toBe("superseded");
		expect(stale.factVersions.quantity).toBe(2);
		expect(stale.facts.quantity).toMatchObject({
			value: 20_000,
			unit: "bags",
			status: "unverified",
			sourceRef: "message-quantity-v2",
		});
	});

	it("records a candidate Fact and requires an authoritative resolution source", () => {
		const { engine } = harness();
		engine.create(command("create-facts", 0));
		const started = engine.startProposal(command("start-facts", 1));
		const candidate = engine.recordFactVersion({
			...command("record-goal", started.aggregateVersion),
			factKey: "task.goal",
			factVersion: 1,
			value: "Summarize a repository",
			status: "unverified",
			sourceType: "user_input",
			sourceRef: "message-1",
		});
		const verified = engine.resolveFact({
			...command("verify-goal", candidate.aggregateVersion),
			factKey: "task.goal",
			decision: "verified",
			sourceRef: "confirmation-1",
		});

		expect(verified.facts["task.goal"]).toMatchObject({
			value: "Summarize a repository",
			version: 2,
			status: "verified",
			sourceType: "human_confirmation",
			sourceRef: "confirmation-1",
			recordedBy: "user-1",
			recordedAt: "2026-09-01T00:00:00.000Z",
		});
		expect(engine.readFactCommand(scope, "verify-goal")).toMatchObject({
			key: "task.goal",
			version: 2,
			status: "verified",
		});
		expect(engine.resolveFact({
			...command("verify-goal", candidate.aggregateVersion),
			factKey: "task.goal",
			decision: "verified",
			sourceRef: "confirmation-1",
		}).aggregateVersion).toBe(verified.aggregateVersion);
		expect(() => engine.recordFactVersion({
			...command("forge-verified", verified.aggregateVersion),
			factKey: "task.deadline",
			factVersion: 1,
			value: "tomorrow",
			status: "verified",
			sourceType: "user_input",
			sourceRef: "message-2",
		})).toThrowError(expect.objectContaining({
			code: "illegal_transition",
		}) as Partial<EnterpriseKernelError>);
	});

	it("invalidates a fresh Artifact when a new field Fact enters its Run", () => {
		const { engine } = harness();
		const waiting = prepareProposal(engine);
		const stale = engine.recordFactVersion({
			...command("record-new-deadline", waiting.aggregateVersion),
			factKey: "task.deadline",
			factVersion: 1,
			value: "2026-09-10",
			status: "unverified",
			sourceType: "user_input",
			sourceRef: "message-deadline",
		});

		expect(stale.stageStatus).toBe("revision_required");
		expect(stale.currentProposal?.freshness).toBe("stale");
		expect(stale.approval?.status).toBe("superseded");
	});

	it("restarts the stage and creates Proposal v2 from the latest Fact lineage", () => {
		const { engine } = harness();
		const waiting = prepareProposal(engine);
		const stale = engine.recordFactVersion({
			...command("quantity-v2", waiting.aggregateVersion),
			factKey: "quantity",
			factVersion: 2,
			value: 20_000,
			unit: "bags",
			status: "unverified",
			sourceType: "user_input",
			sourceRef: "message-quantity-v2",
		});
		const restarted = engine.restartProposal(
			command("restart-proposal", stale.aggregateVersion),
		);
		const v2 = engine.completeProposal({
			...command("complete-proposal-v2", restarted.aggregateVersion),
			runtime: { executionId: "runtime-2", adapterId: "fake-runtime" },
			artifact: {
				artifactId: "solution-proposal",
				schemaVersion: "solution-proposal.v1",
				contentRef: "memory://proposal/v2",
				inputFactVersions: { quantity: 2, contents: 1 },
			},
			evaluation: {
				passed: true,
				reportRef: "memory://evaluation/v2",
			},
			approvalId: "approval-a-v2",
		});

		expect(v2.currentProposal).toMatchObject({
			artifactId: "solution-proposal",
			version: 2,
			freshness: "fresh",
			inputFactVersions: { quantity: 2, contents: 1 },
		});
		expect(v2.proposalVersions).toHaveLength(2);
		expect(v2.proposalVersions[0].freshness).toBe("stale");
		expect(v2.approval).toMatchObject({
			approvalId: "approval-a-v2",
			artifactVersion: 2,
			status: "requested",
		});
	});

	it("persists a failed evaluation without requesting Approval A", () => {
		const { engine, store } = harness();
		engine.create(command("create", 0));
		engine.startProposal(command("start", 1));
		const failed = engine.completeProposal({
			...command("failed-proposal", 2),
			runtime: {
				executionId: "runtime-failed",
				adapterId: "fake-runtime",
			},
			artifact: {
				artifactId: "solution-proposal",
				schemaVersion: "solution-proposal.v1",
				contentRef: "memory://proposal/failed",
				inputFactVersions: {},
			},
			evaluation: {
				passed: false,
				reportRef: "memory://evaluation/failed",
			},
			approvalId: "must-not-be-created",
		});

		expect(failed.stageStatus).toBe("retryable_failed");
		expect(failed.approval).toBeUndefined();
		expect(store.read(scope).map((event) => event.data.type)).not.toContain(
			"approval.requested",
		);
	});

	it("deduplicates a repeated command before evaluating its now-stale expected version", () => {
		const { engine, store } = harness();
		engine.create(command("create", 0));
		const first = engine.startProposal(command("start", 1));
		const repeated = engine.startProposal(command("start", 1));

		expect(repeated).toEqual(first);
		expect(store.read(scope)).toHaveLength(2);
		expect(store.readCommand(scope, "start")).toHaveLength(1);
	});

	it("rejects concurrent writes with an old aggregate version", () => {
		const { engine } = harness();
		engine.create(command("create", 0));
		engine.startProposal(command("start", 1));

		expect(() => engine.recordFactVersion({
			...command("late-fact", 1),
			factKey: "quantity",
			factVersion: 1,
			value: 10_000,
			unit: "bags",
			status: "unverified",
			sourceType: "user_input",
			sourceRef: "message-late-fact",
		})).toThrowError(expect.objectContaining({
			code: "concurrency_conflict",
		}) as Partial<EnterpriseKernelError>);
	});

	it("does not allow another tenant or workspace to address the run", () => {
		const { engine } = harness();
		engine.create(command("create", 0));

		expect(() => engine.load({
			tenantId: "tenant-b",
			workspaceId: "workspace-a",
			runId: scope.runId,
		})).toThrowError(expect.objectContaining({
			code: "aggregate_access_denied",
		}) as Partial<EnterpriseKernelError>);
	});

	it("reconstructs identical business state from the append-only event stream", () => {
		const { engine, store } = harness();
		const expected = prepareProposal(engine);
		const recovered = new ProposalRunEngine(store).load(scope);

		expect(recovered).toEqual(expected);
	});
});


it("accepts a reserved version gap but rejects invalid or reused Artifact versions", () => {
	const { engine } = harness();
	engine.create(command("gap-create", 0)); engine.startProposal(command("gap-start", 1));
	engine.linkProposalRuntime({ ...command("gap-runtime", 2), executionId: "runtime-gap", adapterId: "fake" });
	const artifact = { artifactId: "brief", schemaVersion: "brief.v1", contentRef: "artifact://brief/v3", inputFactVersions: {}, runtimeExecutionId: "runtime-gap" };
	for (const version of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) expect(() => engine.createProposalArtifact({ ...command(`invalid-${version}`, 3), ...artifact, artifactVersion: version })).toThrow("monotonically");
	const created = engine.createProposalArtifact({ ...command("gap-artifact", 3), ...artifact, artifactVersion: 3 });
	expect(created.currentProposal?.version).toBe(3);
	const invalidated = engine.invalidateSource({ ...command("gap-invalidate", created.aggregateVersion), reason: "source change" });
	const restarted = engine.restartProposal(command("gap-restart", invalidated.aggregateVersion));
	for (const version of [1, 2, 3]) expect(() => engine.createProposalArtifact({ ...command(`reuse-${version}`, restarted.aggregateVersion), ...artifact, artifactVersion: version })).toThrow("monotonically");
});
