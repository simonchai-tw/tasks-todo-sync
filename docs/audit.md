# Release-candidate audit

Audit date: 2026-08-22
Candidate: `0.1.0-rc.5` / intended prerelease tag `v0.1.0-rc.5`

## RC decision

This candidate is suitable for a **first public release candidate only**. It is not stable or production-ready. The project is a single-operator Google Apps Script bridge between Google Tasks and Microsoft To Do, not a hosted multi-user service.

The three safety switches remain required defaults:

- `SYNC_ALLOW_DELETIONS=false`
- `SYNC_ALLOW_LIST_DELETIONS=false`
- `SYNC_ALLOW_TASK_MOVES=false`

Task and list deletion logic is implemented but has not yet completed a week of real-account observation. Google-origin cross-list movement is implemented as guarded create-before-delete rather than provider-ID-preserving movement. It is independently enabled by the move switch, uses a durable recovery journal, rereads the old Microsoft source before deletion, and keeps the retired provider ID tombstoned for 30 days. Microsoft-origin movement normally converges through counterpart creation plus ordinary two-round missing-task deletion. `dryRunReport()` is read-only and previews currently detected Google-origin moves, but is not a guarantee about later mutations.

## Evidence reviewed

- Static validation passed.
- The current local automated test suite passed.
- The staging Apps Script Code and manifest were verified as matching.
- A staging 15-minute trigger ran successfully on 2026-08-22.
- Staging `healthCheck()` returned healthy status with zero reported issues.

These observations deliberately omit private mappings, task/list counts, timestamps, project identifiers, and Apps Script version numbers. They establish a bounded staging baseline, not a production claim.

## Corrections and safeguards included

1. Invalid batch Property deletion was replaced with supported per-key deletion.
2. Microsoft task IDs and list IDs are now kept distinct in relevant comparisons and repair paths.
3. The manifest keeps its pinned OAuth2 library and includes the trigger-management scope; Google Tasks advanced service is enabled.
4. Auto discovery prioritizes existing ID mappings, pairs default lists by platform identity, accepts only unique same-name custom-list matches, and creates a counterpart only for eligible one-sided lists. It excludes Flagged Emails, shared/non-owned, unknown, and configured excluded lists.
5. Explicit pairing remains available for deployments that require manual ID-based control; it does not infer pairs from titles.
6. Task deletion is guarded by independent snapshots, delete-versus-edit checks, journals, and tombstones. List deletion adds auto-mode provenance, complete inventory evidence, exact task fingerprints, re-reads, and per-pair journals.
7. Setup helpers make the safe defaults visible: `initializeSafeDefaults()` preserves unrelated Script Properties, while `setupStatus()` reports configuration and trigger readiness without disclosing credentials.
8. State inspection/export and prior-generation recovery are intentionally constrained by active sync fences, task-move/deletion journals, and tombstone-evidence checks.
9. Move recovery persists intent before remote creation, adopts exactly one time-bounded fingerprint match after an uncertain response, waits through two complete inventories before retrying an unmatched create, and fails closed on ambiguity.
10. Move-versus-edit checks run before destination creation and again through a fresh source reread before source deletion. A newer or concurrently changed Microsoft task is preserved and reported instead of overwritten.
11. The unusual observation of one Microsoft task ID in a different list fails closed instead of silently rewriting the mapping or bouncing the task.

## RC5 observability review

RC5 adds a deterministic, privacy-bounded `pendingMoves[]` preview alongside the existing human-readable report. Preview identifiers are opaque labels; the report does not add per-task Graph reads. The metadata summary distinguishes fields observed in the current Microsoft task snapshot from relationship contents that are not expanded. In particular, `hasAttachments=true` is an observable hint, while attachment contents, checklist items, linked resources, and extensions remain uninspected.

The preview is read-only and point-in-time. It does not reserve a future mutation, prevent an account-side edit after the report, or claim to precompute the Microsoft-origin new-task plus missing-task path.

## Remaining blockers before a stable release

- Real-account destructive smoke tests for both task and list deletion, performed only with recoverable test data.
- A complete field matrix for title, notes/content, date-only due dates, and completion state.
- OAuth refresh, reauthorization, and recovery exercises.
- A rehearsed source rollback and separately rehearsed state rollback.
- Provider APIs do not make the cross-cloud move atomic. Conditional writes/ETags should be revisited if the Microsoft task endpoint adds a documented contract; current protection is a fresh reread and fail-closed recovery, whose safe residue can be a temporary duplicate.
- The recovery journal has no provider-side correlation marker. If a user manually creates an otherwise unmapped Microsoft task with exactly the same synchronized fields inside the bounded 10-minute recovery window, that task can be adopted as the uncertain create result. Ambiguous multiple matches stop safely, but a single coincidental match can merge logical identity.
- Real-account cross-list smoke tests in both directions, including interrupted recovery, Microsoft-only metadata loss, and a concurrent Microsoft edit.
- Capacity behavior for large state, long content, many tasks, and long-running scheduled use.
- A complete per-task mutation plan if a future dry-run safety guarantee beyond the current move preview is needed.
- Clear public release operations: private vulnerability reporting enabled, no private notes/snapshots in the release, and a verified CI run.

Until those items are closed, keep the safety switches off and describe releases only as RCs.
