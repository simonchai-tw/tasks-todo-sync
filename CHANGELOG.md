# Changelog

All notable changes to this project are documented here.

Historical entries below describe each release at the time it shipped, including defaults that later changed. For current installation behavior, use the [README](README.md), [Quick start](docs/quick-start.md), [Deployment guide](docs/deployment.md), and [current audit](docs/audit.md). Fresh `v0.2.2` projects use automatic list discovery with task deletion, list deletion, and cross-list task moves enabled.

## Unreleased

## 0.2.2 — 2026-08-31

- Added a public roadmap item for a reusable, local Microsoft setup and recovery wizard that preserves self-hosting and keeps credentials private.
- Simplified the README license line and documented that CodeQL runs through GitHub Default setup.

## 0.2.1 — 2026-08-31

- Refined the public documentation around destination-first cross-list moves, deterministic 600-pair evidence, real-account validation boundaries, and Microsoft client-secret rotation.
- Improved the storage-pressure email with safe, end-user cleanup guidance while preserving automatic tombstone expiry and fail-closed storage behavior.

## 0.2.0 — 2026-08-30

### Compressed state and capacity validation

- Switched new `sync_state_main` generations to gzip+Base64 with a manifest-recorded codec version, UTF-8 decoded-size check, and SHA-256 integrity digest. Existing URI-encoded state remains readable and is migrated automatically on its next successful state save; malformed, truncated, or unknown generations fail closed.
- Retained only the generations needed for current operation and successful-round recovery. A state save has a bounded three-generation peak while the new candidate is promoted, so successful-round recovery does not silently consume unbounded User Properties storage.
- Changed new cross-list move-journal fingerprints to compact Base64 SHA-256 digests. Existing journals containing the canonical raw JSON fingerprint remain readable and continue to require an exact match.
- Kept the installed trigger cadence at 10 minutes. Last-write-wins now gives Google precedence for equal provider timestamps; independent provider clocks can still skew, the winner is recorded only in the execution log, and the overwritten version is not retained separately.
- Made storage-pressure alerts default to the Google account that owns and authorized the private Apps Script project. Set `ALERT_EMAIL` only when a different inbox is intended.
- Added deterministic validation with 600 tracked task pairs across synchronization, deletion, movement, recovery, pagination, and long-content scenarios. See the [engineering audit](docs/audit.md) for the measured model and limits.
- Verified the local regression suite, package checks, deterministic 600-pair validation, and `git diff --check` for this release worktree.

## 0.1.3 — 2026-08-28

### Release hardening and cross-list usability

- Added privacy-bounded persisted health errors so `healthCheck()` does not expose raw provider response bodies.
- Enabled `SYNC_ALLOW_TASK_MOVES=true` for fresh projects after bidirectional real-account validation was completed. Cross-list moves use a destination-first replacement: the new counterpart is created and verified under a durable recovery journal before the old counterpart is retired. Provider-only metadata without a cross-platform equivalent may not transfer.
- Aligned the current setup, security, audit, README, and disposable-data validation documentation with the release behavior and the simple `npx tasks-todo-sync init` flow.
- Verified the `v0.1.3` local regression suite, static validation, package dry-run validation, the packed-package smoke check, and `git diff --check`.

## 0.1.2 — 2026-08-28

### Hotfix

- Fixed state-property preflight to measure actual UTF-8 bytes, avoiding false `STATE_PROPERTY_VALUE_LIMIT` failures for Unicode state and multi-chunk mappings.
- Added Unicode and multi-chunk regression coverage, including the no-partial-write overage guard.

## 0.1.1 — 2026-08-28

### Recovery, integrity, and deployment safeguards

- Fixed `npx tasks-todo-sync init --timezone <IANA>` so non-`Asia/Taipei` time zones are applied by parsing and updating the manifest JSON rather than relying on a particular whitespace layout. The packed-package smoke check remains part of release verification.
- Added a round fence that preserves the last successful task/list-deletion baseline when an incomplete run exits; only proof from the incomplete round is discarded.
- Separated successful-round manifests from intra-round checkpoints. `restorePreviousSyncState()` now restores only a verifiable successful generation; after an upgrade, complete one successful sync before relying on restore, and legacy state without that evidence fails closed.
- Preserved Microsoft rich-text task bodies when a Google-side change affects only title, date, or completion state. A body update is limited to a changed notes text projection.
- Added bounded authorization refresh/error behavior and redacted fatal alert output. Raw state exports and recovery receipts remain sensitive private data.
- Added fail-closed pagination guards, aggregate User Properties storage-headroom checks, and privacy-bounded per-round `durationMs`, `urlFetchCalls`, and `stateSaveCalls` metrics. The final local release checks verified these guards.
- Retained public defaults of automatic list discovery, task deletion enabled, list deletion enabled, and task moves disabled. Ordinary changes normally appear within 0–10 minutes on the 10-minute trigger; two-round deletion confirmation normally settles within 10–20 minutes.
- Verified the `v0.1.1` local regression suite together with `npm run check`, `npm run smoke:package`, and `git diff --check`.

## 0.1.0 — 2026-08-26

### First stable release

- Promoted the package, CLI, validation metadata, setup guides, audit, and security policy from `0.1.0-rc.7` to the first stable `0.1.0` release. The synchronizer and private Apps Script source are unchanged by this release preparation.
- Made the two-account setup requirement explicit at the start of the public guides: each operator authorizes one Google account and one Microsoft account during setup, while the number of sign-in and consent pages depends on existing sessions and provider flows.
- Retained fresh-project defaults of automatic list discovery, `SYNC_ALLOW_DELETIONS=true`, `SYNC_ALLOW_LIST_DELETIONS=true`, and `SYNC_ALLOW_TASK_MOVES=false`. Cross-list task moves remain default-off and outside the stable scope pending real-account validation.
- Consolidated the public README so the guided `Get started` command appears once, while retaining the GitHub Issues entry point.

## 0.1.0-rc.7 — 2026-08-26

### Deployment productization

- Documented the intended first-run command, `npx tasks-todo-sync init`. The CLI uses `clasp` to create a private standalone Apps Script project, defaults to this computer's resolved IANA time zone, accepts `--timezone <IANA>` as an override, pushes the exact `Code.gs` and `appsscript.json` sources, and prints the editor URL with post-deploy steps.
- Clarified that the CLI only deploys source and prints guidance; after opening the editor, the operator must run `initializeSafeDefaults()` to fill missing Script Properties. The CLI does not execute Apps Script functions or write Script Properties.
- Kept Microsoft Entra app registration, client-secret creation, Script Properties, redirect URI setup, and Microsoft authorization manual and private. The CLI never accepts or stores Microsoft credentials or OAuth tokens.
- Documented fresh-project defaults filled by `initializeSafeDefaults()` as automatic list discovery, `SYNC_ALLOW_DELETIONS=true`, `SYNC_ALLOW_LIST_DELETIONS=true`, and `SYNC_ALLOW_TASK_MOVES=false`. Existing explicit Script Properties are preserved, including the maintainer's private all-true deployment.
- Completed bidirectional real-account validation for task and list deletion. These features remain destructive; cross-list task moves remain default-off, low priority, and unverified on a real account.
- Added a manual Apps Script fallback for environments that cannot resolve the package or for operators who want to inspect each deployment step.

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
- Documented provider-ID replacement and the Microsoft-only metadata that cross-provider movement cannot preserve.
- Public destructive-feature defaults remain `false`; the maintainer's private Apps Script settings are not repository defaults.

## 0.1.0-rc.3 — 2026-08-22

Public prerelease tag: `v0.1.0-rc.3`. This is a release candidate, not a stable or production-ready release.

- Historical pre-rc.4 behavior: added bidirectional cross-list convergence using delete-and-recreate semantics instead of preserving provider task IDs.
- Google-origin moves retire the old Microsoft mapping, recreate the counterpart in the newly mapped list, and tombstone the old Microsoft task ID.
- Microsoft-origin moves converge through the existing new-task path plus two-round deletion confirmation for the old counterpart.
- Added regression coverage for both move directions, retry after an already-missing source counterpart, and complete deletion-state cleanup.
- Public destructive-feature defaults remain `false`; personal operators can opt in after disposable-data testing.

## 0.1.0-rc.2 — 2026-08-22

Public prerelease tag: `v0.1.0-rc.2`. This is a release candidate, not a stable or production-ready release.

- Added safe setup helpers: `initializeSafeDefaults()` sets the four setup defaults without overwriting unrelated Script Properties, and `setupStatus()` reports configuration and trigger readiness without revealing credentials.
- Added schema 3 handling for the two-sided custom-list deletion lifecycle and the separate `SYNC_ALLOW_LIST_DELETIONS` safety switch. It requires auto-mode provenance, complete two-round evidence, exact task mappings/fingerprints, a pre-delete reread, and a durable per-pair journal.
- Kept task deletion, list deletion, and task moves independently disabled by default. Task and list deletion code existed, but validation against destructive account data was still pending; task moves remained safely unavailable because no recoverable move journal existed.
- Tightened auto list discovery: existing ID mappings take precedence; default lists pair by platform identity; only unique same-name custom lists pair automatically; excluded, shared, non-owned, unknown, and Flagged Emails lists are not candidates.
- Added public-RC documentation, MIT licensing, release metadata, and a pinned CI matrix for Node.js 22 and 24.
- Recorded staging evidence for static checks, the local test suite, matching Apps Script source/manifest, a successful trigger, and a healthy status with no reported issues. This evidence did not make the project production-ready.

## 0.1.0-rc.1 — 2026-08-15

`0.1.0-rc.1` was a private candidate only. It was never a public Git tag or public release.

- Converted the original Markdown implementation into a `clasp`-managed Google Apps Script project with static checks and local regression tests.
- Fixed invalid Properties API usage, Microsoft task/list ID mix-ups, manifest/library configuration, and trigger scope coverage.
- Added bounded task deletion handling, safe auto/explicit list pairing, state export/previous-generation recovery, and list fault repair safeguards.
- Added initial deployment and security guidance while retaining the RC boundary.
