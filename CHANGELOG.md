# Changelog

All notable changes to this project are documented here.

## Unreleased

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
