# Project reliability audit and closure record

Date: 2026-10-22. Checkout: `codex/workspace-cleanup`, starting at `9db25e4b7754cc6d70828554086a5b0e1aefb910`. The initial working tree was clean. A fresh fetch found main at `42ff79c8a8e680ab436c170ca2d6f1aaab4e7b1d`; this branch contained that tip and five later local commits. The shared context library refreshed successfully at `f9d55282f10b12641656e7378763ae78e470e057`.

The audit inspected the current source, historical failure audit, roadmap, default checks, local environment, and read-only GitHub state. GitHub had no open Issues and one open draft PR, #56. Its five checks passed for `81f594ca115ec2a95a6a3926afe640c775d7a672`; those results do not validate this patch.

## Fixed findings

| Finding | Observed failure | Change and regression evidence |
| --- | --- | --- |
| Knowledge indexing can monopolize the worker | An embedding that ignores cancellation never releases the scheduled Job without an external abort. A late result also committed when elapsed time exceeded the deadline but the timer had not fired. | `KnowledgeService.execute` imposes 120 seconds, checks elapsed time at the commit boundary, and maps expiry to retryable `timeout`. `server/knowledge/errorHandling.audit.test.ts` covers cancellation, timeout, delayed timer, discarded late results, and subsequent work. Both timeout regressions failed before their fixes. |
| Shutdown races worker cleanup and treats shutdown as job failure | `stop()` returned before handler cleanup; the scheduler classified its own stop cancellation as non-retryable. The Host closed SQLite stores when HTTP stopped even if a background handler was still unwinding. | Scheduler draining precedes storage closure, bounded by five seconds. The active lease remains recoverable without incrementing failure count. `server/workers/stageJobScheduler.test.ts` covers drain ordering, no further claims, and recovery by a new worker. The regression failed before the fix. |
| Interrupted uploads leave a lock and incomplete request identity | Forced termination at attachment byte publication left a directory lock. Original-request retries failed with `attachment_store_unavailable`. Bytes and metadata also lacked a recoverable full-request intent. | Attachments reuse the existing process-owned lock and persist a private intent before bytes. Forced termination before/after byte publication, identical retry, changed content/name rejection, and a single visible final attachment are covered by `server/fileWriteLock.test.ts`. Legacy locks and conflicting bytes remain preserved. |
| Successful file writes lacked explicit flushing | Session, snapshot, Trace, ledger, Artifact, and attachment writes used rename without flushing their temporary contents and containing directory. | Writes now flush contents and use `syncDirectory`. `server/storageDurability.test.ts` injects post-rename flush failures and checks error classification, preserved data, revision conflicts, and safe retries. Existing forced-process-termination and immutability regressions remain in place. This is not a power-cut test. |
| Locked tooling contains known security findings | Current dependency audit reported high=1 and moderate=2 for Vite/Vitest and the existing mocker dependency. | Pin Vite 7.3.7 and Vitest 4.1.12; update only their existing package family. Explicit audit returns zero findings. Sources, MIT notices, and integrity values are recorded in `docs/dependencies.md`. |

The changes stay in Enterprise/Host storage, scheduling, knowledge execution policy, and existing tooling. They do not add Agent Core capabilities, model calls, tool permissions, a provider, or an external side effect. Attachment intent is a private recovery record; it does not create a Fact or approval.

## Verification

Initial `npm run check`: 1,358 passed, 50 existing platform skips; type checking and build passed. The skips comprise 38 macOS opt-in checks and 12 Windows checks.

Adding real file flushing exposed test resource pressure. The first full pass with default CPU-sized concurrency and a concurrent browser run timed out in three tests and one setup hook. Four workers removed those failures except two tests that each ran three complete source-invalidation scenarios inside a five-second test. Those six existing scenarios now have separate test cases. No assertion, test-discovery rule, timeout, or platform skip was relaxed. The test runner caps concurrent disk-heavy fixtures at four workers.

Validation on the final runtime and dependency changes:

| Check | Result |
| --- | --- |
| Core suite | 1,369 passed, 50 platform skips; 132 files passed and 2 files skipped. |
| Type checking and production build | Passed with Vite 7.3.7. |
| Fixed offline evaluations | All 12 passed: offline, context, recovery, loop-safety, memory, m1, m2, plan, plan-graph, plan-parallel, source-report, and packaging-lifecycle. |
| macOS native suite | 48 passed, zero skips. This separately exercises the macOS checks skipped in the default suite. |
| Actual Host product smoke | Passed with a local deterministic provider, including restart, cancellation, source invalidation, approval, files, and delivery paths. No paid model was called. |
| Browser suite | 63 passed across desktop Chinese, narrow Chinese, and narrow English; zero skipped, unexpected, or flaky results. |
| Dependency audit | Zero findings at every severity. |
| Workflow/path policy and secret scan | Passed. The tracked working-tree snapshot and all Git history had zero secret findings; the scanner also rejected its synthetic negative controls. |

The 12 Windows-specific default-suite skips remain unexecuted on this macOS host. A local green result does not establish the result of future GitHub checks, Windows 11 acceptance, or real-user acceptance.

## Status of the older G1–G7 backlog

Follow-up: G2, G3 and G6 are now closed by [durable recovery and bounded delivery](durable-recovery-closure-2026-10-22.md). The rows below retain the findings at this initial audit checkpoint.

| Earlier item | Current disposition | Remaining completion evidence |
| --- | --- | --- |
| G1 indexing deadline | Fixed for scheduled imports; cancellation and late-result protection verified offline. | Blocking native inference still needs process isolation before claiming forced termination of its compute. Direct store callers own their execution policy. |
| G2 non-file tool reconciliation | Still open. The current recovery adapter covers file writes/deletes. Memory proposals and automation mutations retain `started`/`unknown` when their business commit cannot be reconciled. | Add a receipt in each business transaction, bind it to the original scope/input/approval, and prove recovery causes zero repeated mutations. Do not infer success from current mutable state. |
| G3 Session/Trace/telemetry split commit | Still open. Missing completion evidence continues to block automatic replay. | Persist a complete completion intent and test every Session/Trace write window before enabling repair. Provider billing cannot be inferred or guaranteed exactly once. |
| G4 locks and durability | Attachment process locks and the identified missing file flushes are fixed. | Legacy locks require owner review. Windows directory flush, power loss, filesystem faults, and multi-host locking remain unverified. |
| G5 multi-store partial success | The attachment intent/bytes/metadata window now supports an identical retry. | Knowledge raw/SQLite and Artifact/Event boundaries still rely on immutable identities and existing retry/review paths; there is no global transaction or automatic orphan deletion. |
| G6 Outbox/Cron retry policy | Still open. Outbox has capped backoff but no total attempt ceiling; Cron creates separately bounded Jobs without an automatic failure circuit breaker. | Define persistent terminal delivery state, operator visibility/redrive, and a Cron failure policy. Verify that a failed delivery neither duplicates work nor starves unrelated scopes. |
| G7 shutdown and cleanup | Worker drain and shutdown lease preservation are fixed. | The five-second forced-exit path still depends on persisted checkpoints and subsequent lease recovery. It cannot guarantee completion of arbitrary blocked I/O. |

At this initial checkpoint, these items were recorded as engineering debt. The linked follow-up implements and verifies G2, G3 and G6. Unknown execution and completion records still block automatic replay. Completing G2 and G3 requires durable evidence in the affected business transactions; completing G6 requires a persisted terminal delivery state and operator redrive, plus an explicit Cron failure policy. A generic success repair or retry counter alone would leave those recovery paths incomplete.

Real employee acceptance, Windows 11 desktop/release acceptance, paid-model benchmarking, and power-failure validation still require their own inputs and environments. No production data migration, forced lock removal, deployment, push, or merge occurred in this audit.

## Reproduction entry points

```sh
npm run check
node --import tsx scripts/ci.ts core
node --import tsx scripts/ci.ts native
node --import tsx scripts/ci.ts browser
node --import tsx scripts/ci.ts policy
node --import tsx scripts/ci.ts secrets
node --import tsx scripts/ci.ts audit
npm run doctor
```

Focused checks: `server/knowledge/errorHandling.audit.test.ts`, `server/workers/stageJobScheduler.test.ts`, `server/fileWriteLock.test.ts`, `server/storageDurability.test.ts`, and `server/runtime/conversationAttachments.test.ts`. Local diagnostic logs use the `/tmp/packx-audit-*` prefix and are not product artifacts or customer data.
