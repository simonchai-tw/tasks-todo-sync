# Release-candidate audit

Audit date: 2026-08-23
Candidate: `0.1.0-rc.6` / intended prerelease tag `v0.1.0-rc.6`

## RC decision

This candidate is suitable for a **first public release candidate only**. It is not stable or production-ready. The project is a single-operator Google Apps Script bridge between Google Tasks and Microsoft To Do, not a hosted multi-user service.

The three safety switches remain required defaults:

- `SYNC_ALLOW_DELETIONS=false`
- `SYNC_ALLOW_LIST_DELETIONS=false`
- `SYNC_ALLOW_TASK_MOVES=false`

Task and list deletion logic is implemented but has not yet completed a week of real-account observation. Google-origin cross-list movement is implemented as guarded create-before-delete rather than provider-ID-preserving movement. It is independently enabled by the move switch, uses a durable recovery journal and provider-side correlation marker, rereads the old Microsoft source before deletion, and keeps the retired provider ID tombstoned for 30 days. Microsoft-origin movement normally receives a new Microsoft ID: with deletion disabled it creates a new Google counterpart while preserving the old one indefinitely; with deletion enabled it normally converges through counterpart creation plus a later complete missing-task confirmation round. `dryRunReport()` is read-only and previews currently detected Google-origin moves, but is not a guarantee about later mutations.

## Evidence reviewed

- Static validation passed.
- The rc.6 local automated suite passed 168/168 tests on 2026-08-24.
- Prior rc.5 Apps Script, CI, and release evidence exists, but rc.6 deployment and publication are separate release steps and are not claimed by this source audit.

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
9. Move recovery persists a UUID intent before remote creation and writes the same UUID in a Microsoft open type extension in the destination POST. Only unresolved target lists use the documented `$expand=extensions($filter=id eq 'com.tasksTodoSync.move')` short-name query. Graph To Do can return either exact service-normalized identity, `microsoft.graph.openTypeExtension.com.tasksTodoSync.move` or legacy `Microsoft.OutlookServices.OpenTypeExtension.com.tasksTodoSync.move`; local recovery uses that exact two-value allowlist and also requires one target-list, unmapped, exact-extension-name, valid-UUID, and fingerprint match. Bare names, suffix matches, other prefixes, and content-only matches are never adopted.
10. Move-versus-edit checks run before destination creation and again through a fresh source reread before source deletion. A newer or concurrently changed Microsoft task is preserved and reported instead of overwritten.
11. The unusual observation of one Microsoft task ID in a different list fails closed instead of silently rewriting the mapping or bouncing the task.

## RC6 move recovery and operations review

The rc.5 deterministic, privacy-bounded `pendingMoves[]` preview remains read-only and does not add per-task Graph reads. Its metadata summary distinguishes fields observed in the current Microsoft task snapshot from relationships that are not expanded. In particular, `hasAttachments=true` is an observable hint, while attachment contents, checklist items, linked resources, and extensions remain uninspected by dry-run.

During an actual `syncAll()`, rc.6 selectively expands extensions only for target lists that have unresolved correlated move journals. It never performs an extension read per task. If that list expansion fails or is incomplete, the journal cannot adopt, retry-create, or delete a source. Multiple matching markers and marker/content disagreement fail closed.

Pre-rc.6 journals remain schema-compatible. A legacy `created` journal with a known destination ID can complete under strict source/destination rereads. A legacy unresolved journal has no correlation identity, so unattended sync cannot adopt a fingerprint lookalike or issue a replacement POST. The operator must use the guarded reconcile workflow or cancel only after manually returning the Google task.

The new move-journal inspection, preview, and apply helpers expose deterministic opaque references, bounded reasons, timestamps, and counts only. Apply is protected by the global lock, active-fence rejection, strict state, exact revision/token validation, fresh live reads, and a private User Properties before-image receipt. It mutates one journal only and never calls a provider mutation helper. Blocked and legacy journals are now explicit `healthCheck()` issues.

The preview is read-only and point-in-time. It does not reserve a future mutation, prevent an account-side edit after the report, or claim to precompute the Microsoft-origin new-task plus missing-task path.

## Scheduling boundary

The installed trigger is now 10 minutes. Apps Script's single execution ceiling is six minutes; the script budgets 5.25 minutes and leaves 45 seconds before that ceiling. Task/list deletion recovery and apply paths, plus move create/delete boundaries, stop with an additional 45-second reserve inside the internal budget before live reads, durable journal saves, and remote mutations. Existing durable journals remain recoverable and current-round volatile confirmations are rolled back before catch-save. Ten minutes is the first supported minute cadence above the hard limit. This affects latency, not the two-round safety predicate: ordinary changes normally appear within 0–10 minutes, while two-complete-round cleanup normally takes 10–20 minutes.

There is no persistent Google page cursor, Graph next-link/delta token, or sharded inventory checkpoint. A time-budget exit saves durable state but the next invocation starts a complete inventory. If a complete inventory always exceeds the internal budget, neither a 10- nor 15-minute trigger can make that inventory complete.

## Remaining blockers before a stable release

- Real-account destructive smoke tests for both task and list deletion, performed only with recoverable test data.
- A complete field matrix for title, notes/content, date-only due dates, and completion state.
- OAuth refresh, reauthorization, and recovery exercises.
- A rehearsed source rollback and separately rehearsed state rollback.
- Provider APIs do not make the cross-cloud move atomic. Conditional writes/ETags should be revisited if the Microsoft task endpoint adds a documented contract; current protection is a fresh reread and fail-closed recovery, whose safe residue can be a temporary duplicate.
- Real-account rc.6 cross-list smoke tests in both directions, including interrupted extension recovery, Microsoft-only metadata loss, and a concurrent Microsoft edit.
- Capacity behavior for large state, long content, many tasks, and long-running scheduled use.
- Persistent cursor/delta or sharding design for an account whose complete inventory cannot finish within 5.25 minutes.
- A complete per-task mutation plan if a future dry-run safety guarantee beyond the current move preview is needed.
- Clear public release operations: private vulnerability reporting enabled, no private notes/snapshots in the release, and a verified CI run.

Until those items are closed, keep the safety switches off and describe releases only as RCs.
