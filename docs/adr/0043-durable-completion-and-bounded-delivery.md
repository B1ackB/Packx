# ADR-0043: Durable completion receipts and bounded delivery

Status: Accepted. Date: 2026-10-22.

## Context

The failure audit left three related gaps: a non-file tool could commit business state without completing its execution ledger (G2); a final reply could commit without its Trace (G3); Outbox delivery could retry indefinitely and Cron could keep starting occurrences after failed jobs (G6).

Mutable current state cannot prove what a tool returned. Repeating a write, generating another reply, or increasing retry budgets cannot establish the missing evidence. Existing Enterprise stores already provide atomic transactions, immutable snapshots, scoped access and deterministic job identities.

## Decision

Keep recovery in Enterprise stores and Host adapters. Reuse the current execution reconciliation hook, snapshot port, process-owned file lock and operator API. Add no Agent Core capability, model routing, external dependency or background repair agent.

### Mutation receipts

`memory_propose`, `background_task_create`, `background_task_cancel`, `cron_create`, `cron_pause` and `cron_resume` record the original JSON result in the same transaction as their business change. The receipt binds tenant, workspace, run, stage, actor, execution, tool call, tool, idempotency key, approval and the Core-compatible `sha256:` input digest. Queue and Cron receipts travel with the business object; memory receipts share the existing SQLite transaction with state and audit events.

The Host validates the current local owner and conversation before reconciliation. The existing Runtime checks current tool availability and actor, then uses the receipt to resolve the original `started` or `unknown` ledger record with compare-and-set. Reconciliation records its evidence reference and never executes the tool. Results remain historical when the job, schedule or memory later changes. A memory receipt contains candidate metadata, never an approval or the forgotten body.

Queue and Cron objects retain at most 256 receipts. Reaching that limit rejects the next mutation before committing it. A missing or conflicting receipt preserves uncertainty. Existing business objects are not backfilled with guessed results.

### Turn completion

After final output validation, the Host writes one immutable `turn-completion.v1` intent through the existing snapshot store before saving the final Session. It contains the original Trace and usage, sanitized messages, input/actor/output-contract identity, original revision and content digest, and expected committed content digest. The deterministic snapshot ID belongs to the session and turn key. `context_read` rejects this private namespace.

Runtime retry checks request identity, current context and sources, then either commits the unchanged base Session or recognizes its exact committed target. It writes the original Trace without another model call. A different Session revision/content, request, actor, output contract or current source blocks repair. It does not write a conflicting failed Trace after preparing completion.

Conversation duplicate handling and the Host's Plan recovery adapter also repair historical completion evidence before their existing result lookup. This path restores only the exact base/target recorded by the Host and checks the local actor. Historical model completion does not assert current business validity: Plan input checks, approvals, output parsing and completed-source review still apply. Read-only completed-source inspection itself does not write repairs.

Legacy final replies without an intent cannot acquire a synthetic successful Trace. Provider computation or responses lost before a durable completion intent remain outside this protocol. A telemetry write failure before preparation still reports failure with its original cause; there is no inferred provider charge or exactly-once billing claim.

### Outbox and Cron

Outbox keeps its existing exponential delay, capped at 30 seconds, and stops after five failed delivery attempts. Invalid jobs and identity conflicts become dead letters immediately. Successful publication and dead-letter state are terminal until an operator explicitly redrives a dead letter. The record retains cumulative deliveries, failure detail and recovery audit history; a new operator cycle resets only its consecutive-failure budget.

Cron persists a `pendingJobId` and starts no later occurrence until that job completes. A cancelled job pauses the schedule; an exhausted job marks it `failed` and keeps the failed job reference. The operator must repair and redrive that job through the existing job endpoint. Completion of the redriven job allows the next occurrence, subject to the original `maxRuns` budget. Ordinary `cron_resume` cannot bypass a failed schedule.

Dispatch infrastructure failures retain the same occurrence identity, back off, and stop after five failures. Each due schedule is isolated so one failure does not prevent unrelated due schedules from dispatching. Operators can recover a failed dispatch with no pending job; this preserves its original occurrence and does not consume another run. Operator recovery requires the observed update timestamp, actor, reason and request ID. Failure/recovery timestamps advance monotonically even when the clock does not advance. Exact repeated requests have no additional effect; changed or stale requests fail. Outbox and Cron retain at most 64 operator recovery records.

## Compatibility and migration

New fields are optional in existing Queue, Cron and Outbox documents; existing records remain readable. Existing pending Outbox messages without `failureCount` count their historical deliveries toward the failure ceiling. Old Cron records acquire pending-job tracking on their next acknowledged occurrence. The change does not reconstruct results or job links missing from historical records.

Queue and Cron file adapters now use the existing SQLite process-owned lock and flush the directory after atomic replacement. Legacy directory locks stay intact for owner review. Do not run older writers against upgraded records: older versions do not understand the new terminal states or receipt guarantees. Restore a compatible backup for rollback instead of deleting receipts or clearing locks. No production migration or lock removal runs as part of this change.

## Alternatives and exit conditions

A cross-store transaction coordinator would add an unnecessary persistence framework. Inferring a result from mutable state, clearing unknown claims, or replaying a model/tool would lose identity and side-effect guarantees. Unbounded retries would hide permanent failures and permit recurring cost.

Retain this protocol while stores remain single-host and writes use their existing transaction boundaries. A multi-host backend must provide equivalent atomic receipt writes, fencing and immutable intent semantics before replacing these adapters. Power-loss behavior and Windows directory flushing need separate platform evidence.

## Evidence

Regression entry points: `mutationRecovery.test.ts`, `turnCompletion.test.ts`, `durableRecovery.process.test.ts`, `outboxDelivery.test.ts`, `cronRecovery.test.ts`, and `proposalWorkerApi.test.ts`. The [closure record](../evidence/durable-recovery-closure-2026-10-22.md) records the complete check results and operator procedure.
