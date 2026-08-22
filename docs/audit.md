# Release-candidate audit

Audit date: 2026-08-22
Candidate: `0.1.0-rc.3` / intended prerelease tag `v0.1.0-rc.3`

## RC decision

This candidate is suitable for a **first public release candidate only**. It is not stable or production-ready. The project is a single-operator Google Apps Script bridge between Google Tasks and Microsoft To Do, not a hosted multi-user service.

The three safety switches remain required defaults:

- `SYNC_ALLOW_DELETIONS=false`
- `SYNC_ALLOW_LIST_DELETIONS=false`
- `SYNC_ALLOW_TASK_MOVES=false`

Task and list deletion logic is implemented but has not yet completed a week of real-account observation. Cross-list movement is implemented as delete-and-recreate rather than provider-ID-preserving movement; it requires task deletion, retires the old mapping, and keeps the old provider ID tombstoned for 30 days. `dryRunReport()` is a read-only configuration/list report, not a task-level mutation plan.

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
8. State inspection/export and prior-generation recovery are intentionally constrained by active sync fences, deletion journals, and tombstone-evidence checks.

## Remaining blockers before a stable release

- Real-account destructive smoke tests for both task and list deletion, performed only with recoverable test data.
- A complete field matrix for title, notes/content, date-only due dates, and completion state.
- OAuth refresh, reauthorization, and recovery exercises.
- A rehearsed source rollback and separately rehearsed state rollback.
- Concurrency protections such as conditional writes/ETags, plus delete-versus-edit race coverage.
- Capacity behavior for large state, long content, many tasks, and long-running scheduled use.
- A genuine per-task mutation plan if a future dry-run safety guarantee is needed.
- Clear public release operations: private vulnerability reporting enabled, no private notes/snapshots in the release, and a verified CI run.

Until those items are closed, keep the safety switches off and describe releases only as RCs.
