# Changelog

All notable changes to this project are documented here.

## Unreleased

## 0.1.0-rc.6 — 2026-08-23

Public prerelease tag: `v0.1.0-rc.6`. This remains a release candidate, not a stable or production-ready release.

- Replaced fingerprint-only interrupted-move adoption with a per-journal UUID and a Microsoft Graph open type extension written atomically with the destination task. Recovery uses the documented short-name extension filter only for unresolved target lists, then locally accepts only the exact `microsoft.graph.openTypeExtension.` and legacy `Microsoft.OutlookServices.OpenTypeExtension.` identities for the exact extension name, plus a valid matching UUID, destination list, unmapped task, and synchronized-field fingerprint. Bare names, suffix matches, other prefixes, missing, duplicate, edited, or unreadable evidence fail closed.
- Kept pre-rc.6 move journals readable. A legacy `created` journal with a known destination ID can finish under the existing strict rereads, while an unresolved legacy journal cannot auto-adopt or recreate a task.
- Added privacy-bounded `inspectTaskMoveJournals()`, `previewTaskMoveJournalOperation()`, and `applyTaskMoveJournalOperation()` operations for guarded resume, cancel, and reconcile workflows. Preview tokens bind the normalized action, journal reference/revision, candidate reference, confirmation, and live evidence. Apply requires an exact read-back of the newly serialized private before-image receipt and changes only local journal state; provider mutation remains the next `syncAll()` responsibility.
- Added task-move health observability with bounded phase/reason counts. Blocked or legacy journals now make `healthCheck()` unhealthy without exposing provider IDs, task content, or correlation values.
- Changed the installed Apps Script trigger from 15 to 10 minutes. Apps Script still has a six-minute single-execution limit; this project budgets 5.25 minutes and adds a 45-second internal reserve before destructive journal revalidation, durable save, and provider mutation. Time-budget exits retain durable journals, roll back volatile current-round confirmations, and restart a complete inventory on the next run because no persistent page cursor, delta token, or shard checkpoint exists.
- Documented Microsoft-origin move behavior: with task deletion disabled the new-ID and old Google counterparts can remain as two tasks; with deletion enabled the old counterpart normally converges after a later complete confirmation round.
- Expanded local regression coverage for fully-qualified correlation identity, crash recovery without duplicate POST, intent-bound preview tokens, exact receipt read-back, destructive fake-clock budget boundaries, legacy compatibility, privacy, health, trigger cadence, and timeout wording.
- Public destructive-feature defaults remain `false`.

## 0.1.0-rc.5 — 2026-08-22

Public prerelease tag: `v0.1.0-rc.5`. This is an observability-focused release candidate, not a stable or production-ready release.

- Added structured `pendingMoves[]` data to the read-only move preview, while retaining the human-readable `actions[]` and `warnings[]` output.
- Added per-candidate metadata-loss reporting that distinguishes observed Microsoft task fields from relationships that the current inventory does not expand.
- Added deterministic, privacy-bounded dry-run assertions and a disposable-list validation runbook; no real account is intentionally throttled.
- Public destructive-feature defaults remain `false`.

## 0.1.0-rc.4 — 2026-08-22

Public prerelease tag: `v0.1.0-rc.4`. This is a release candidate, not a stable or production-ready release.

- Reworked Google-origin cross-list movement into a guarded create-before-delete transaction with a durable `taskMoveJournal`.
- Added interrupted-create recovery: one exact destination match is adopted, ambiguous matches fail closed, and an uncertain result is observed across two inventory rounds before a create retry.
- Added move-versus-edit protection before mutation and a fresh Microsoft source reread before deletion. A newer or concurrently changed Microsoft task is preserved and reported as a conflict.
- Decoupled `SYNC_ALLOW_TASK_MOVES` from general task-deletion propagation. Google-origin movement can be tested without enabling ordinary missing-task deletion.
- Added fail-closed handling for the unusual same-ID Microsoft cross-list observation and a read-only move preview in `dryRunReport()`.
- Documented provider-ID replacement and the Microsoft-only metadata that delete-and-recreate cannot preserve.
- Public destructive-feature defaults remain `false`; the maintainer's private Apps Script settings are not repository defaults.

## 0.1.0-rc.3 — 2026-08-22

Public prerelease tag: `v0.1.0-rc.3`. This is a release candidate, not a stable or production-ready release.

- Added bidirectional cross-list convergence using delete-and-recreate semantics instead of preserving provider task IDs.
- Google-origin moves retire the old Microsoft mapping, recreate the counterpart in the newly mapped list, and tombstone the old Microsoft task ID.
- Microsoft-origin moves converge through the existing new-task path plus two-round deletion confirmation for the old counterpart.
- Added regression coverage for both move directions, retry after an already-missing source counterpart, and complete deletion-state cleanup.
- Public destructive-feature defaults remain `false`; personal operators can opt in after disposable-data testing.

## 0.1.0-rc.2 — 2026-08-22

Public prerelease tag: `v0.1.0-rc.2`. This is a release candidate, not a stable or production-ready release.

- Added safe setup helpers: `initializeSafeDefaults()` sets the four setup defaults without overwriting unrelated Script Properties, and `setupStatus()` reports configuration and trigger readiness without revealing credentials.
- Added schema 3 handling for the two-sided custom-list deletion lifecycle and the separate `SYNC_ALLOW_LIST_DELETIONS=false` safety switch. It requires auto-mode provenance, complete two-round evidence, exact task mappings/fingerprints, a pre-delete reread, and a durable per-pair journal.
- Kept task deletion, list deletion, and task moves independently disabled by default. Task and list deletion code exists but neither has completed a real destructive-account smoke test; task moves remain safely unavailable because no recoverable move journal exists.
- Tightened auto list discovery: existing ID mappings take precedence; default lists pair by platform identity; only unique same-name custom lists pair automatically; excluded, shared, non-owned, unknown, and Flagged Emails lists are not candidates.
- Added public-RC documentation, MIT licensing, release metadata, and a pinned CI matrix for Node.js 22 and 24.
- Recorded staging evidence for static checks, the local test suite, matching Apps Script source/manifest, a successful 15-minute trigger on 2026-08-22, and a healthy status with no reported issues. This evidence does not make the project production-ready.

## 0.1.0-rc.1 — 2026-08-15

`0.1.0-rc.1` was a private candidate only. It was never a public Git tag or public release.

- Converted the original Markdown implementation into a `clasp`-managed Google Apps Script project with static checks and local regression tests.
- Fixed invalid Properties API usage, Microsoft task/list ID mix-ups, manifest/library configuration, and trigger scope coverage.
- Added bounded task deletion handling, safe auto/explicit list pairing, state export/previous-generation recovery, and list fault repair safeguards.
- Added initial deployment and security guidance while retaining the RC boundary.
