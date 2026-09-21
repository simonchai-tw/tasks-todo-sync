# Changelog

All notable changes to this project are documented here.

Historical entries below describe each release at the time it shipped, including defaults that later changed. For current installation behavior, use the [README](README.md), [Quick start](docs/quick-start.md), [Deployment guide](docs/deployment.md), and [current audit](docs/audit.md). Fresh `v0.7.0` projects use automatic list discovery with task deletion, list deletion, cross-list task moves, subtask sync, resource projection, and Time Bridge (due time and reminder synchronization) enabled.

## 0.7.0 — 2026-09-21

### Time Bridge v2.4 (Due Time & Reminder Sync with Google Calendar Projection)

- **Bidirectional Due Time & Reminder Synchronization**:
  - Bridges the architectural gap between Microsoft To Do's native reminder/due time support and Google Tasks' date-only API limitation.
  - Splicing notes marker `[TTS-TIME:HH:mm]` (Spec §2.1): parses strict uppercase 24-hour time (`00:01`–`23:59`) from the first line of Google Tasks notes, automatically stripping the marker and preserving clean user notes.
  - Projects 30-minute timed events with `start.dateTime` onto a dedicated secondary Google Calendar (`Tasks-ToDo-Sync`), making task due times visible on Google Calendar schedules.
  - Deterministic SHA-256 event ID mapping with zero negative byte corruptions and automated completion cleanup (deletes calendar projection when task is completed or removed).
  - Tri-State Field Ownership Protocol: Google-authored tasks with notes markers take precedence; Microsoft-authored tasks take precedence when `reminderDateTime` is updated in To Do.
  - Fail-Closed Safety Knobs:
    - `SYNC_TIME_BRIDGE` (default `true`): Master switch to enable/disable Time Bridge processing entirely.
    - `SYNC_CALENDAR_PROJECTION` (default `true`): Toggle to enable/disable Google Calendar event projection while keeping To Do reminder synchronization active.
- **Google Gemini Integration Guide**:
  - Added `docs/gemini-saved-info.md` containing prompt templates for Google Gemini Saved Info / Personalization to automatically generate `[TTS-TIME:HH:mm]` markers via natural voice/chat commands.
- **Test Suite Expansion**:
  - Expanded test coverage to 427 automated tests (100% PASS).

## 0.6.1 — 2026-09-16

### Streamlined resource projection formatting and tag labels

- Refined managed resource projection block to use clean source tags (`[Gmail]`, `[Google Docs]`, `[Google Chat]`, `[Outlook]`, `[File]`, `[Link]`) instead of redundant category headers (`Google Tasks links`) and bullet markers (`- `).
- Avoided appending raw, percent-encoded long URLs when a human-readable title or description is present, preventing clutter in plain-text task notes.
- Seamless in-place overwrite: existing managed blocks in notes are refreshed automatically during the next synchronization cycle.
- Expanded automated test coverage to 417 tests (100% PASS).

## 0.6.0 — 2026-09-16

### 3-step setup wizard, clean resource projection, and frictionless onboarding

- Added a modernized 3-step setup wizard (`Setup.html` and companion backend functions in `setup.gs`/`Code.gs`) for guided Google Tasks permissions, secretless Microsoft Device Code authorization, and one-click 10-minute trigger activation under a strict zero-dynamic-HTML security contract.
- Simplified managed resource projection delimiters from `--- tasks-todo-sync related resources (v1) ---` to clean, unversioned boundaries (`--- tasks-todo-sync ---` and `--- tasks-todo-sync end ---`). Delimiter parsing strips managed blocks before computing notes hash to preserve anti-ping-pong invariants. Legacy `(v1)` blocks are retained as ordinary user notes and are not automatically migrated or deleted.
- Preserved Advanced Entra self-managed OAuth mode alongside Personal Device Code mode for complete private self-hosting without external identity dependencies.
- Added visual `install-flow.svg` architecture diagram and concise onboarding guidance.
- Added open-source community standards: `CONTRIBUTING.md` and `.github/pull_request_template.md`.
- Expanded automated test coverage to 416 automated tests (100% PASS).

## 0.5.0 — 2026-09-16

### Subtask synchronization, resource projection, and scheduler invariants

- Expanded Apps Script runtime to 17 root-level `.gs` files (added `field-merge.gs`, `relationship-discovery.gs`, `resource-projection.gs`, `subtask-classification.gs`, and `subtask-sync.gs`).
- Added bidirectional subtask / checklist synchronization with three-way merge and conflict isolation.
- Added Microsoft-to-Google resource projection and rotating linked-resources observation scheduler with formal proofs.
- Hardened the 3 core scheduler invariants: R-completeness (fail-closed pagination), Two-round deletion with absence probe soundness, and Starvation-free rotating observation cursor.
- Calibrated the runtime budget envelope on live real accounts across two disjoint execution rounds ($R_{\text{floor}} \approx 2.44\text{s}$, $C_{\text{reconcile}} \approx 0.37\text{s/pair}$, $V_{\text{inspect}} \approx 0.521\text{s/pair}$, $W_{\text{delete}} \approx 0.385\text{s/item}$ with S2 batching).
- Added fail-closed `TIME_BUDGET_CREATE` batch entrypoint protection, `'(Untitled)'` placeholder contracts, and empty-title subtask creation guards.
- Expanded automated test coverage to 416 automated tests (100% PASS).

## 0.4.0 — 2026-09-07

- Split the Apps Script runtime into 12 root-level `.gs` files without changing public entrypoints or synchronization behavior.
- Added canonical, reverse, and deterministic shuffled VM load-order gates plus duplicate-global and deploy-set validation.
- Updated the CLI, npm package, and both private/public `.claspignore` templates to use one canonical Apps Script source set.
- Kept legacy single-file directories read-only during upgrade. Migrate through a new directory containing only a copied `.clasp.json` so the same Apps Script project and remote state are retained.
- Added bounded ordinary task-create batches of 25 with a durable per-item User Property progress sidecar (`SYNC_TASK_CREATE_PROGRESS_V1`); each completed batch is checkpointed while the round fence remains open.
- Added fail-closed recovery for uncertain creates: Google→Microsoft uses the dedicated `com.tasksTodoSync.create` extension identity, Microsoft→Google uses a temporary `<!-- tasks-todo-sync-create:<uuid> -->` notes sentinel, and cleanup waits for a positive GET verification. Zero or multiple exact candidates never trigger an automatic repost because provider POST idempotency is undocumented.
- Added guarded operator recovery through `inspectTaskCreateBatch()`, `previewTaskCreateBatchOperation()`, and `applyTaskCreateBatchOperation()`, including explicit duplicate-risk confirmation for `RELEASE_FOR_REPOST`.
- Expanded the release evidence to 279 automated tests.

## 0.3.0 — 2026-09-06

- Added a private, responsive setup page for secretless Microsoft Personal Device Code authorization, reconnection, cancellation, and disconnection.
- Kept Advanced Entra OAuth available as an explicit compatibility mode and made Personal-mode switching transactional and live-verified against Microsoft To Do.
- Added a centralized field-compatibility guide and clarified supported installation environments, the conservative 300-pair operating envelope, and the separate 600-pair stress boundary.
- Expanded authorization, packaging, and synchronization coverage to 265 automated tests.
- Pseudonymized default task and list diagnostics so automatic synchronization logs do not expose raw provider IDs.
- Recorded a real-account 600-task observation: the initial create workload stopped safely at the internal budget, converged on the following round, and then completed repeated steady-state rounds well within budget.

- Restored `LICENSE` to the standard MIT template for GitHub license detection and moved the independent-project notice to `NOTICE`.

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
