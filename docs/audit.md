# v0.1.3 release audit

Audit scope: 0.1.3 — 2026-08-28

## Release decision

`v0.1.3` extends the stable personal, single-operator synchronization release with deployment, integrity, recovery, UTF-8 storage, privacy-bounded health reporting, and cross-list move safeguards. It retains the documented two-way task and list deletion paths. Fresh projects enable cross-list task moves after bidirectional real-account validation was completed.

Fresh-project setup uses these values:

- `SYNC_LIST_DISCOVERY_MODE=auto`
- `SYNC_ALLOW_DELETIONS=true`
- `SYNC_ALLOW_LIST_DELETIONS=true`
- `SYNC_ALLOW_TASK_MOVES=true`

Existing explicit Script Properties are preserved. This is intentional: a maintainer's private deployment whose three switches are already `true` remains unchanged.

Task and list deletion are implemented, enabled for fresh projects, and covered by bidirectional real-account validation. They use independent evidence, two-round confirmation, live revalidation, journals, and tombstones. Cross-list task moves are enabled for fresh projects after bidirectional real-account validation was completed, without establishing a universal guarantee. Movement uses delete-and-recreate semantics, so provider-only metadata may not be preserved.

## v0.1.3 scope and verification boundary

- **CLI time zone:** The manifest is parsed and updated as JSON, so non-`Asia/Taipei` IANA zones do not depend on pretty-printing.
- **Round fence:** An incomplete run removes only its current-round proof and retains the previous successful task/list-deletion baseline.
- **Successful-round restore:** Restore reads a separately committed successful generation. An upgraded deployment must first complete and verify one successful sync; legacy state without a verifiable generation fails closed.
- **Rich body preservation:** Metadata-only Google edits leave an existing Microsoft rich-text body unchanged; a changed notes text projection updates the body.
- **Authorization, alert, and health safety:** Refresh/retry and fatal-error behavior are bounded, fatal alerts are redacted, and persisted health error messages are privacy-bounded before `healthCheck()` exposes them.
- **Pagination, storage, and metrics:** Page-token/page-count guards, aggregate User Properties headroom checks, UTF-8 byte accounting, and content-free per-round metrics are implemented and verified by the final local release checks. The preceding [v0.1.1 release notes](release-v0.1.1.md#verification) provide the historical baseline.

## Deployment productization boundary

The supported first-run command is:

```bash
npx tasks-todo-sync init
```

The flow uses `clasp` to create a private standalone Apps Script project, defaults to this computer's resolved IANA time zone or accepts `--timezone <IANA>` as an override, applies that value, pushes the exact `Code.gs` and `appsscript.json` sources, and prints the editor URL plus post-deploy steps. The operator then opens that editor URL and runs `initializeSafeDefaults()`; the CLI does not open the editor, execute Apps Script functions, or write Script Properties.

Microsoft Entra app registration, client-secret creation, Script Properties, redirect URI setup, and Microsoft authorization remain manual and private. The CLI never accepts or stores Microsoft credentials or OAuth tokens. If the package cannot be resolved, the documented manual Apps Script fallback remains available.

## Evidence reviewed

- Static validation, the local automated suite, `npm run check`, `npm run smoke:package`, and `git diff --check` passed in the `v0.1.3` release worktree.
- The `v0.1.2` package and its UTF-8 hotfix checks remain historical evidence. The earlier `v0.1.1` and `v0.1.0` package checks, including the pre-`v0.1.0` `tasks-todo-sync@0.1.0-rc.7` guided-deployment checks, remain historical evidence.
- Prior Apps Script, CI, and release evidence is bounded; deployment and publication are separate release steps and are not inferred from source inspection.
- Bidirectional real-account validation covered task deletion and list deletion.
- The ordinary scheduled sync/health evidence observed no unexpected creates, moves, deletes, or conflicts in its bounded run; it is not a complete account-configuration test.

These observations deliberately omit private mappings, task/list counts, timestamps, project identifiers, credentials, and Apps Script version numbers. They establish the verified private baseline for this stable release scope.

## Corrections and safeguards included

1. Invalid batch Property deletion was replaced with supported per-key deletion.
2. Microsoft task IDs and list IDs are kept distinct in relevant comparisons and repair paths.
3. The manifest keeps its pinned OAuth2 library and includes the trigger-management scope; Google Tasks advanced service is enabled.
4. Auto discovery prioritizes existing ID mappings, pairs default lists by platform identity, accepts only unique same-name custom-list matches, and creates a counterpart only for eligible one-sided lists. It excludes Flagged Emails, shared/non-owned, unknown, and configured excluded lists.
5. Explicit pairing remains available for deployments that require manual ID-based control; it does not infer pairs from titles.
6. Task deletion is guarded by independent snapshots, delete-versus-edit checks, journals, and tombstones. List deletion adds auto-mode provenance, complete inventory evidence, exact task fingerprints, re-reads, and per-pair journals.
7. Setup helpers fill the fresh-project values above without overwriting unrelated or existing explicit Script Properties, while `setupStatus()` reports configuration and trigger readiness without disclosing credentials.
8. State inspection/export and prior-generation recovery are constrained by active sync fences, task-move/deletion journals, and tombstone-evidence checks.
9. Move recovery persists a UUID intent before remote creation and writes the same UUID in a Microsoft open type extension in the destination POST. Only unresolved target lists use the documented `$expand=extensions($filter=id eq 'com.tasksTodoSync.move')` short-name query. Graph To Do can return either exact service-normalized identity, `microsoft.graph.openTypeExtension.com.tasksTodoSync.move` or legacy `Microsoft.OutlookServices.OpenTypeExtension.com.tasksTodoSync.move`; local recovery uses that exact two-value allowlist and also requires one target-list, unmapped, exact-extension-name, valid-UUID, and fingerprint match. Bare names, suffix matches, other prefixes, and content-only matches are never adopted.
10. Move-versus-edit checks run before destination creation and again through a fresh source reread before source deletion. A newer or concurrently changed Microsoft task is preserved and reported instead of overwritten.
11. The unusual observation of one Microsoft task ID in a different list fails closed instead of silently rewriting the mapping or bouncing the task.

## Cross-list move boundary

Google-origin cross-list movement is a guarded create-before-delete transaction rather than provider-ID-preserving movement. It uses a durable recovery journal and provider-side correlation marker, rereads the old Microsoft source before deletion, and keeps the retired provider ID tombstoned for 30 days. Microsoft-origin movement normally receives a new Microsoft ID: with an existing explicit `SYNC_ALLOW_DELETIONS=false`, the new Google counterpart can coexist with the old one; with the fresh-project value `true`, it normally converges through counterpart creation plus a later complete missing-task confirmation round.

`dryRunReport()` is read-only and previews detected Google-origin moves, but it is not a guarantee about later mutations. Its metadata summary distinguishes fields observed in the current Microsoft task snapshot from relationships that are not expanded; attachment contents, checklist items, linked resources, and extensions remain uninspected.

## Scheduling boundary

The supported trigger cadence is 10 minutes. Apps Script's single-execution ceiling is six minutes; the script budgets 5.25 minutes and leaves 45 seconds before that ceiling. Task/list deletion recovery and apply paths, plus move create/delete boundaries, stop with an additional 45-second reserve inside the internal budget before live reads, durable journal saves, and remote mutations. Existing durable journals remain recoverable and current-round volatile confirmations are rolled back before catch-save.

Pagination uses bounded page-token/page-count and execution-budget guards; it fails closed on repeated tokens or unreasonable page counts. There is no persistent Google page cursor, Graph next-link/delta token, or sharded inventory checkpoint. A time-budget exit saves durable state but the next invocation starts a complete inventory. If a complete inventory always exceeds the internal budget, a longer trigger interval cannot make that inventory complete. User Properties writes check estimated aggregate headroom, including retained generations and other user properties. Each round records privacy-bounded `durationMs`, `urlFetchCalls`, and `stateSaveCalls` metrics without task/list content. The final local release checks verified these guards; the preceding [v0.1.1 release notes](release-v0.1.1.md#verification) remain the historical baseline.

When both providers report a change, last-write-wins compares Google's `updated` timestamp with Microsoft's `lastModifiedDateTime`. These are independent provider clocks and can have a small clock-skew or commit-latency window, so a simultaneous edit may not always select the intuitively expected winner. This is a known limitation of the current timestamp-based conflict model, not a universal data-loss guarantee.

## Validation backlog after `v0.1.3`

- Interrupted cross-list recovery, Microsoft-only metadata loss, and a concurrent Microsoft edit remain follow-up validation after the completed bidirectional real-account validation.
- A complete field matrix for title, notes/content, date-only due dates, and completion state.
- OAuth refresh, reauthorization, and recovery exercises.
- A rehearsed source rollback and separately rehearsed state rollback.
- Provider APIs do not make the cross-cloud move atomic. Conditional writes/ETags should be revisited if the Microsoft task endpoint adds a documented contract; current protection is a fresh reread and fail-closed recovery, whose safe residue can be a temporary duplicate.
- Capacity behavior for large state, long content, many tasks, and long-running scheduled use.
- Persistent cursor/delta or sharding design for an account whose complete inventory cannot finish within 5.25 minutes.
- A complete per-task mutation plan if a future dry-run safety guarantee beyond the current move preview is needed.

These items remain important follow-up validation, but they do not expand the documented `v0.1.3` scope. Cross-list moves are enabled for fresh projects after bidirectional real-account validation; that validation is evidence for this deployment, not a universal safety guarantee.
