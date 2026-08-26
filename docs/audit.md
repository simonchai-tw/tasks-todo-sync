# Release-candidate audit

Audit scope: 0.1.0-rc.7 — 2026-08-26

## RC decision

This prerelease is suitable for release-candidate review only. It is not stable or production-ready. The project is a single-operator Google Apps Script bridge between Google Tasks and Microsoft To Do, not a hosted multi-user service.

Fresh-project setup uses these values:

- `SYNC_LIST_DISCOVERY_MODE=auto`
- `SYNC_ALLOW_DELETIONS=true`
- `SYNC_ALLOW_LIST_DELETIONS=true`
- `SYNC_ALLOW_TASK_MOVES=false`

Existing explicit Script Properties are preserved. This is intentional: a maintainer's private deployment whose three switches are already `true` remains unchanged.

Task and list deletion are implemented and have bounded maintainer-private recoverable smoke evidence in both directions. They are not universally safe: they remain destructive, use independent evidence and two-round confirmation, and do not make the candidate production-ready. Cross-list task moves remain off by default, low priority, and unverified on a real account.

## Deployment productization boundary

The intended first-run command is:

```bash
npx tasks-todo-sync init
```

The intended flow uses `clasp` to create a private standalone Apps Script project, default to this computer's resolved IANA time zone or accept `--timezone <IANA>` as an override, apply that value, push the exact `Code.gs` and `appsscript.json` sources, and print the editor URL plus post-deploy steps. The operator must then open that editor URL and run `initializeSafeDefaults()`; the CLI does not open the editor, execute Apps Script functions, or write Script Properties.

Microsoft Entra app registration, client-secret creation, Script Properties, redirect URI setup, and Microsoft authorization remain manual and private. The CLI must never accept or store Microsoft credentials or OAuth tokens. If the package cannot be resolved, the documented manual Apps Script fallback remains available. These deployment instructions are not a production-readiness claim.

## Evidence reviewed

- Static validation and the rc6 local automated suite passed 168/168 tests in the candidate worktree.
- Prior Apps Script, CI, and release evidence is bounded; deployment and publication are separate release steps and are not inferred from source inspection.
- Bounded maintainer-private recoverable task-deletion and list-deletion smoke checks covered both directions.
- The ordinary scheduled sync/health evidence observed no unexpected creates, moves, deletes, or conflicts in its bounded run; it is not a complete account-configuration test.

These observations deliberately omit private mappings, task/list counts, timestamps, project identifiers, credentials, and Apps Script version numbers. They establish a bounded private baseline, not a public production claim.

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

There is no persistent Google page cursor, Graph next-link/delta token, or sharded inventory checkpoint. A time-budget exit saves durable state but the next invocation starts a complete inventory. If a complete inventory always exceeds the internal budget, neither a 10- nor 15-minute trigger can make that inventory complete.

## Remaining blockers before a stable release

- Real-account cross-list smoke tests in both directions, including interrupted recovery, Microsoft-only metadata loss, and a concurrent Microsoft edit. Cross-list moves remain low priority and unverified.
- A complete field matrix for title, notes/content, date-only due dates, and completion state.
- OAuth refresh, reauthorization, and recovery exercises.
- A rehearsed source rollback and separately rehearsed state rollback.
- Provider APIs do not make the cross-cloud move atomic. Conditional writes/ETags should be revisited if the Microsoft task endpoint adds a documented contract; current protection is a fresh reread and fail-closed recovery, whose safe residue can be a temporary duplicate.
- Capacity behavior for large state, long content, many tasks, and long-running scheduled use.
- Persistent cursor/delta or sharding design for an account whose complete inventory cannot finish within 5.25 minutes.
- A complete per-task mutation plan if a future dry-run safety guarantee beyond the current move preview is needed.
- Clear public release operations: private vulnerability reporting enabled, no private notes/snapshots in the release, verified CI, and a separately verified package publication if one is intended.

Until those items are closed, keep describing releases only as RCs. Fresh task/list deletion defaults do not change that boundary, and cross-list moves must remain described as default-off and unverified on real accounts.
