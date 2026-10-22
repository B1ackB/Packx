# G2, G3 and G6 closure

Date: 2026-10-22. Branch: `codex/workspace-cleanup`. Starting commit: `c35120b`. The working tree was clean at the start of this follow-up. This record follows the [initial project audit](project-closure-2026-10-22.md); [ADR-0043](../adr/0043-durable-completion-and-bounded-delivery.md) defines the recovery protocol.

## Closed findings

| Item | Implemented behavior | Durable regression evidence |
| --- | --- | --- |
| G2: non-file mutations without ledger completion | Six mutation tools persist an immutable result receipt with business state. Host recovery verifies the original identity and resolves the ledger without executing the write again. | `server/runtime/mutationRecovery.test.ts`: restart, changed mutable state, scoped identity/input/approval rejection, cancellation, rollback, Core ledger replay and memory confirmation/forget boundaries. `durableRecovery.process.test.ts`: SIGKILL after Queue, Cron and memory commits while the ledger remains started. |
| G3: final Session without Trace | A completion intent precedes the final Session. Runtime, conversation retry and Plan result recovery repair the exact Session/Trace result without another model call. | `server/runtime/turnCompletion.test.ts`: five failure boundaries, repeated retry, changed input/actor/output contract/session/context, revoked sources, cancellation, private readback, legacy fail-closed behavior, conversation retry and Plan recovery. `durableRecovery.process.test.ts`: SIGKILL after intent, Session and Trace commits. |
| G6: unbounded delivery and recurring failure | Outbox reaches a persistent dead letter after five failures or immediately for permanent job errors. Cron waits for its previous job, stops on job exhaustion, bounds dispatch errors, and supports audited operator recovery. | `server/workers/outboxDelivery.test.ts`: memory/file/SQLite parity, reopen, lost ACK, permanent errors, exact operator retry and scope/version rejection. `cronRecovery.test.ts`: no overlap, failed job retention/redrive, original run budget, fault isolation and dispatch recovery. `proposalWorkerApi.test.ts` and the actual Host product smoke cover operator access. |

Recovery never creates verified Facts, approves a memory, increases a schedule's run budget, or treats an unknown provider bill as confirmed. Existing records without the required immutable evidence remain blocked for review.

## Operator procedure

These endpoints require a valid local-session header and the separately configured `BLACKX_OPERATOR_API_TOKEN` as a Bearer credential. Worker credentials do not grant operator access. The Host supplies the local tenant, workspace and actor; cross-scope header overrides are rejected.

1. Read `GET /api/stage-jobs/outbox` or `GET /api/stage-jobs/cron`. Inspect the failure, object ID and `updatedAt`.
2. Repair the underlying cause. For an Outbox dead letter, post to `/api/stage-jobs/outbox/{messageId}/redrive`. For a failed Cron dispatch with no `pendingJobId`, post to `/api/stage-jobs/cron/{scheduleId}/redrive`.
3. Send an object with `requestId`, the exact observed `expectedUpdatedAt`, and a concrete `reason`. Retry an uncertain response with the same request body. A conflict requires rereading the state; do not substitute a new ID to bypass review.
4. For Cron with a failed `pendingJobId`, use the existing `/api/stage-jobs/{jobId}/redrive` endpoint after inspecting `/api/stage-jobs/dead-letter`. Cron stays stopped until that same job completes. Schedule recovery and model `cron_resume` reject attempts to skip it.
5. Inspect status again. Outbox publication means queue delivery; it does not mean the queued business task succeeded. Cron `completed` means its bounded occurrences finished. Business approvals and evaluations retain their own completion rules.

Unknown/missing job data, conflicting intents and legacy locks are preserved. There is no automatic deletion or success override. File-store recovery is single-host; old writers must not run against the new records.

## Validation

The change adds 44 regression cases and splits 12 existing qualification scenarios into separate cases. Diagnostic logs use `/tmp/packx-closure-*`; they contain synthetic fixtures and are not product records.

| Check | Result |
| --- | --- |
| Final core suite | 1,425 passed, 50 platform skips; 137 files passed and 2 skipped. |
| Type checking and production build | Passed. A test-only activity-type import was corrected after the last full test pass; the subsequent type check/build passed. |
| Fixed offline evaluations | All 12 passed again on the final implementation: offline, context, recovery, loop-safety, memory, m1, m2, plan, plan-graph, plan-parallel, source-report, packaging-lifecycle. |
| macOS native suite | 48 passed, zero skipped. |
| Actual Host smoke | Passed using a local deterministic provider, including the operator HTTP routes, tenant-header rejection, restart, cancellation, files, source invalidation and approvals. |
| Browser suite | 63 passed across desktop Chinese, narrow Chinese and narrow English; zero skipped, unexpected or flaky results. |
| Dependency audit | Zero findings at every severity. No dependency changed in this follow-up. |
| Workflow/path policy and secret scan | Passed, including scanner negative controls and tracked-file/history scans. |

The default suite's 50 skips comprise 38 macOS opt-in checks covered by the separate native run and 12 Windows-only checks. Windows-specific execution remains unverified on this macOS host. New recovery suites are included in the CI-required core discovery list and applicable Windows local-data list.

The first full run exposed two obsolete assertions (all snapshot reads counted as source reads, and age-based legacy lock removal) and a setup hook that ran all 12 qualification scenarios under one 30-second deadline. Source-read limits remain 128; completion-intent lookup is counted separately. Legacy unknown locks now remain intact. The same 12 scenarios and 31 checkpoints have separate bounded test cases, with their aggregate and mutation checks preserved. No production deadline or security assertion was relaxed. Fixed-clock regressions also verify that Outbox/Cron recovery timestamps advance monotonically, so an old observed version cannot authorize a later recovery cycle.

## Evidence boundaries

Local checks do not establish remote CI, Windows desktop acceptance, real employee acceptance or paid-model quality. Forced process termination is not a power-cut test. Responses lost before an intent is durably written cannot be reconstructed, and provider billing is not exactly once. No project push, merge, deployment, production-data rewrite or automatic lock removal is part of this closure.
