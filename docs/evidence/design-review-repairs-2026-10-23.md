# Design review repairs

Date: 2026-10-23. Starting commit: `f2b4d1f0b0f727db849a6ce70bc833477333cddc`. Working branch: `codex/review-design-fixes`.

This change follows the codebase-design, ponytail-review and code-review assessment. Work proceeds from business correctness to small deletions and then existing module boundaries. It does not add dependencies or Agent Core capabilities.

## Changes

1. **Keep unresolved Fact proposals across fresh brief generations.** Read pending changes from immutable prior requirement briefs, retain proposals against the current verified Fact version, and deduplicate repeated proposals. A model omitting a proposal or repeating the old value cannot clear it. Existing human edits/confirmation or source invalidation advance the authoritative Fact version; the existing review workflow remains responsible for resolution. More than 30 unresolved proposals fail before publishing an invalid brief, preserving earlier artifacts and recovery evidence.
2. **Enforce the Cron interval over the bounded run budget.** Use the pinned Croner parser to inspect all authorized future occurrences, with the existing two-occurrence minimum. Creation and resume reject intervals below five minutes and insufficient finite occurrences. Dispatch checks persisted schedules before enqueue; failures use the existing bounded retry state. A replay of a successful resume returns its immutable receipt even after schedule completion, while preserving scope, approval and execution identity checks.
3. **Remove unused code.** Delete the orphan fixed-corpus `projectSourceReadTool`; production and evaluation callers already use `createProjectSourceReadTool`. Remove the write-only App source state and its callback. DeliveryPreview continues to render its own delivery sources. Keep the fixture corpus used by evaluations.
4. **Use native file flushing.** Stage Job Queue and Cron Schedule Store use `writeFileSync` with `flush: true` on the existing exclusive temporary file. Preserve atomic rename, private permissions, containing-directory synchronization, locking and classified write failures. This uses the repository's Node 24.14+ baseline and does not establish power-loss guarantees.
5. **Give packaging context assembly a testable boundary.** Move the existing conversation and Runtime context policies from `server/index.ts` into `server/manufacturing/packagingTaskContext.ts`. The module reads current sources through narrow existing interfaces. Keep the generic Enterprise task-context builder, exact stage filters, report revalidation, checkpoint failure classification and local-owner memory delegation. Host construction retains deferred session access; no extra cache, Core policy or global context object is introduced.
6. **Normalize model failures at the adapter boundary.** Runtime and telemetry consume the Host-level `ModelProviderError`, with a bounded code vocabulary, retryability, HTTP status, optional validated usage/response metadata and retained cause. The Anthropic adapter translates both generation and token-count failures. Received output truncation stays non-retryable; context overflow keeps the `context_window_exceeded` code used by the existing single compact recovery. Unknown transport, cancellation and callback failures keep their original identity. The thin adapter-local `AnthropicGenerationError` preserves active evaluation accounting callers and retains the legacy compatibility error in its cause chain, allowing the frozen readback baseline to keep its original classification. No new Core error protocol or recovery strategy is introduced.

## Focused verification

- Requirement brief and Cron regression group: 7 files, 129 tests passed.
- Queue, Cron recovery, worker failure and storage durability group: 5 files, 63 tests passed.
- Automation mutation receipt and recovery group: 2 files, 13 tests passed.
- Cleanup: type checking and production build passed; existing M2/source-tool checks passed (2 files, 5 tests).
- Browser suite: 63 tests passed across desktop Chinese, narrow Chinese and narrow English. The sandbox initially blocked the local test server; the same test command succeeded with local-listener permission.
- Independent review of changes 1–4 found no remaining actionable regressions. The pending-proposal overflow boundary and completed-schedule replay edge were addressed during review.
- Packaging context extraction: type checking/build and 6 focused files with 102 tests passed. Tests include live memory/checkpoint binding changes and revocation during generation preventing subsequent tool execution. Independent review confirmed behavior preservation and safe deferred initialization.
- Provider boundary: 10 focused files with 155 tests passed; after retaining the legacy cause, 6 affected files with 99 tests passed. A separate offline check used the actual frozen baseline Runtime with the current adapter and mocked HTTP responses: all four received-stop cases preserved their historical classification/retry behavior with one generation per Runtime. The frozen baseline's intentionally different output-limit classification remains unchanged.

## Final verification

`node --import tsx scripts/ci.ts core` passed on the final implementation:

- 139 test files passed and 2 Windows-only files skipped; 1,484 tests passed and 50 platform/opt-in tests skipped.
- Type checking and production build passed.
- All 12 fixed offline evaluations passed: offline, context, recovery, loop-safety, memory, m1, m2, plan, plan-graph, plan-parallel, source-report and packaging-lifecycle.

The first sandboxed full-suite attempt passed 1,478 tests; six local proxy tests failed because the sandbox denied listening on `127.0.0.1`. The complete run above succeeded with local-listener permission. No test expectations, timeouts or skips were relaxed.

`node --import tsx scripts/ci.ts native` also passed on the final implementation: production/native builds, all 48 macOS native tests with zero skips, and the actual Host product smoke using a deterministic local HTTP model fixture. The Host run covered authentication and scope isolation, memory/checkpoint updates, immutable report selection, plan execution and restart, source withdrawal, approval blocking, file operations, templates, delivery/export, cancellation and persisted telemetry. This exercises the extracted context module through real Host wiring and the normalized provider adapter through HTTP.

The browser suite passed all 63 tests across its three viewport/language configurations. `git diff --check` passed. Independent reviews of all six changes found no remaining actionable regression; the overflow, receipt-replay and frozen-baseline compatibility edges found during review were fixed and checked.

The default suite's 50 skips comprise 38 macOS opt-in checks and 12 Windows-only checks. The separate native run exercised the 38 macOS opt-in checks. The 12 Windows-specific checks remain unexecuted on this host. These local results do not establish Windows acceptance, remote CI results, real-model quality or power-loss behavior. No live model evaluation, deployment, push or merge was performed.
