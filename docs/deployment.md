# Deployment guide — 0.1.3

## Scope and release boundary

This guide deploys a personal Google Apps Script sync engine. The 10-minute Apps Script trigger is the running service; GitHub hosts the source and release history. `v0.1.3` extends the stable core with deployment, recovery, UTF-8 storage, privacy-bounded health reporting, and cross-list move safeguards. Fresh projects enable cross-list task moves after bidirectional real-account validation was completed. See the [changelog](../CHANGELOG.md) and [v0.1.1 release notes](release-v0.1.1.md) for the current and historical release history.

Use a private project and a small test list for the first rounds so you can confirm the pairing before scheduling. Fresh projects enable task and list deletion, which have been validated in both directions and are protected by confirmation, revalidation, journals, and tombstones. Fresh projects also enable cross-list task movement after bidirectional real-account validation was completed; this does not establish a universal guarantee.

The productized entry point is `npx tasks-todo-sync init`. The manual Apps Script route below is the fallback when the published npm package cannot be resolved or when an operator wants to inspect each deployment step.

## What you need

- A Google account that can use Google Tasks and Apps Script.
- A Microsoft account and permission to register an Entra application for it.
- No Azure pay-as-you-go subscription, VM, database, or other Azure runtime resource. Entra's account-type choice is a sign-in audience, not a chargeable hosting choice.
- Node.js **22 or later** for the `npx` flow, local checks, and `clasp` operations.

Google Apps Script authorization and Microsoft OAuth are separate sign-ins. Authorize one Google account and one Microsoft account during setup. The exact number of pages depends on current sign-in sessions and provider consent prompts, so do not expect exactly two prompts. The CLI handles only the private Apps Script project and source deployment; Microsoft Entra registration, client-secret creation, and Microsoft authorization remain manual and private.

## Productized `init` flow (`v0.1.3`)

Run:

```bash
npx tasks-todo-sync init
```

The command uses `clasp` to:

1. Create a new private standalone Apps Script project.
2. Default to this computer's resolved IANA time zone, or accept `--timezone <IANA>` to override it, then apply that value in `appsscript.json`.
3. Push the exact `Code.gs` and `appsscript.json` sources from this release.
4. Print the Apps Script editor URL and the post-deploy steps for Entra setup, Script Properties, authorization, validation, and trigger creation.

5. Open the printed editor URL and run `initializeSafeDefaults()` in the Apps Script editor. The CLI does not open the editor, execute Apps Script functions, or write Script Properties.

The CLI never accepts, stores, prints, or transmits `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, `MS_TENANT_ID`, OAuth tokens, or other Microsoft credentials. Complete Entra registration and secret creation yourself in Microsoft Entra, then enter the values only in the private Apps Script editor. If `npx` cannot resolve the published npm package, use the manual fallback below.

After you open the editor and run `initializeSafeDefaults()`, the helper fills missing properties for a fresh project with:

| Key | Fresh-project value |
| --- | --- |
| `SYNC_LIST_DISCOVERY_MODE` | `auto` |
| `SYNC_ALLOW_DELETIONS` | `true` |
| `SYNC_ALLOW_LIST_DELETIONS` | `true` |
| `SYNC_ALLOW_TASK_MOVES` | `true` |

`initializeSafeDefaults()` preserves existing explicit Script Properties. In particular, an existing private maintainer deployment with all three switches set to `true` is not changed.

## v0.1.3 release behavior

The release enables cross-list moves for fresh projects and extends bounded diagnostics while preserving the existing recovery model:

| Area | Behavior | Release status |
| --- | --- | --- |
| CLI time zone | Applies the requested IANA time zone to the manifest after parsing JSON, independent of whitespace formatting. | Included and verified by the packed-package smoke check. |
| Round fence | Keeps the previous successful task/list-deletion baseline when a run exits before its final projection; only the incomplete round's proof is discarded. | Included and verified by the final source tests. |
| Successful-round restore | Restores from a separately committed successful generation, never from an intra-round checkpoint. An upgraded deployment needs one verifiable successful sync first; legacy state without that evidence fails closed. | Included and verified by the final source tests; see [state rollback](#sync-state-rollback). |
| Rich body | A Google title, date, or completion-only change does not rewrite an existing Microsoft rich-text body. A changed notes text projection does update the body. | Included and verified by provider payload tests. |
| Authorization and errors | Authorization refresh/retry and fatal alerts have bounded behavior. Fatal alert email is redacted and excludes task/list content, provider IDs, and full responses. | Included and verified by the final 401 and alert assertions. |
| Persisted health errors | Stores only HTTP status, a recognized internal error code, and a bounded request/correlation code instead of raw provider response bodies. | Included and verified by privacy regression tests. |
| Cross-list moves | Fresh projects enable the guarded move journal after bidirectional real-account validation. Existing explicit settings remain unchanged. | Included; delete-and-recreate metadata limits remain documented below. |
| Pagination, storage, and metrics | Page-token/page-count and execution-budget guards fail closed. User Properties headroom and per-round `durationMs`, `urlFetchCalls`, and `stateSaveCalls` are tracked without storing task/list content. | Included and verified by the final local release checks. |

## Manual Apps Script fallback

### 1. Create the private project

1. Create a private standalone project at [script.google.com](https://script.google.com/).
2. In Project Settings, enable display of the `appsscript.json` manifest.
3. Copy this repository's `Code.gs` and `appsscript.json` into the project. Change `appsscript.json`'s `timeZone` to your own IANA time zone before saving; do not inherit `Asia/Taipei` unless it is correct for you.
4. Run `initializeSafeDefaults()` and complete the Google authorization prompts. For a fresh project it fills `SYNC_LIST_DISCOVERY_MODE=auto`, `SYNC_ALLOW_DELETIONS=true`, `SYNC_ALLOW_LIST_DELETIONS=true`, and `SYNC_ALLOW_TASK_MOVES=true` without overwriting existing explicit Script Properties.

Google Tasks due dates are date-only. Microsoft due times are not preserved, so changing the project time zone affects date interpretation but does not create time-of-day round trips.

### 2. Register Microsoft OAuth manually

In Microsoft Entra admin center, create an application registration for your own account:

- Choose the personal-account sign-in audience when only a personal Microsoft account will use the app. Choose the organization-and-personal audience only when that wider access is needed.
- In Microsoft Graph, add **Delegated** `Tasks.ReadWrite`. Do not add application permissions or `User.Read`.
- The program requests `offline_access` through its OAuth scope; it is not a separate Graph permission to add.
- Create a client secret and keep the **secret value** private. The Secret ID is not the secret value.

Use Apps Script **Project Settings → Script Properties** for configuration:

| Key | Required | Value |
| --- | --- | --- |
| `MS_CLIENT_ID` | Yes | Your Entra Application (client) ID |
| `MS_CLIENT_SECRET` | Yes | Your client-secret value |
| `MS_TENANT_ID` | No | Leave unset for `common`, or use your intended tenant setting |
| `ALERT_EMAIL` | No | A private alert address |
| `SYNC_LIST_DISCOVERY_MODE` | Yes | `auto` for a fresh project; preserve an existing explicit value |
| `SYNC_EXCLUDED_LIST_NAMES` | No | List names to exclude, one per line or comma-separated |
| `SYNC_ALLOW_DELETIONS` | Yes | `true` for a fresh project; preserve an existing explicit value |
| `SYNC_ALLOW_LIST_DELETIONS` | Yes | `true` for a fresh project; preserve an existing explicit value |
| `SYNC_ALLOW_TASK_MOVES` | Yes | `true` for a fresh project; preserve an existing explicit value |

Never put these values, OAuth tokens, raw state, or IDs in the repository, issues, or screenshots. The CLI does not collect or store them.

### 3. Set the redirect URI and authorize

1. Run `showRedirectUri()` and copy the URL from the execution log.
2. In Entra, open **Authentication**, choose **Add a platform**, choose **Web**, and add that exact URL as a redirect URI.
3. Run `startAuthorization()`, open the returned URL, and sign in with the intended Microsoft account.
4. Run `setupStatus()` and resolve unexpected warnings. It reports readiness without showing credential values.

### 4. Verify before adding the schedule

1. Run `dryRunReport()` and review its warnings, exclusions, faults, list information, and `pendingMoves[]` entries. It is read-only and point-in-time; attachments, checklist items, linked resources, and extensions are relationships that the current inventory does not expand, so the report must not claim that they are absent.
2. With a small test list, run `syncAll()` twice and inspect both services. The second run should not make unexpected duplicates.
3. Task and list deletion are enabled for fresh projects and have been verified in both directions. Review the two-round confirmation and tombstone results before adding the schedule.
4. Run `createTrigger()` only after the staging results are acceptable. It deletes earlier `syncAll` triggers and creates one 10-minute trigger.
5. After it runs, use `healthCheck()` and `setupStatus()` to check health and trigger state.

Cross-list task moves use `SYNC_ALLOW_TASK_MOVES=true` for fresh projects. Bidirectional real-account validation is complete; this is not a universal guarantee. Movement uses delete-and-recreate semantics, so provider-only metadata such as reminders, recurrence, importance, categories, attachments, and history may not be preserved. Review the move notes below and the separate validation runbook before making large-scale changes.

### Task and list deletion behavior

Task deletion uses independent snapshots, delete-versus-edit checks, durable journals, and 30-day tombstones. List deletion additionally requires auto-mode provenance, complete inventory evidence, exact task fingerprints, a pre-delete reread, and a durable per-pair journal. Bidirectional real-account validation covers both deletion directions with recoverable test data.

If an existing deployment explicitly has `SYNC_ALLOW_DELETIONS=false`, Microsoft-origin movement can leave the new Google counterpart alongside the old one. With the fresh-project value `true`, a later complete confirmation round normally retires the old counterpart after a temporary duplicate.

## Runtime cadence and capacity boundary

Google Apps Script enforces a six-minute limit for one execution. The script's own `RUN_LIMIT_MS` is 5.25 minutes, leaving 45 seconds before the platform ceiling. Destructive task, list, and move-journal paths reserve another 45 seconds inside that budget and fail fast before live revalidation, durable journal writes, or remote deletion; an existing durable journal remains for the next full-inventory run. Ten minutes is the first supported Apps Script minute-trigger cadence above the platform ceiling. A global lock skips an overlapping invocation instead of running two syncs concurrently.

- Ordinary changes normally appear in 0–10 minutes.
- A two-complete-round deletion or Microsoft-origin old-task cleanup normally converges in 10–20 minutes.
- Throttling, authorization failure, an incomplete inventory, or a skipped overlapping trigger can make either longer.

Pagination has a bounded page-token/page-count guard and stops safely on repeated tokens, unreasonable page counts, or insufficient execution time. Time-budget recovery does not resume a partially fetched page set. Neither the Google nor Microsoft inventory stores a page cursor, delta token, or shard checkpoint. The next trigger begins a complete inventory again. If one full inventory consistently takes more than 5.25 minutes, a longer trigger interval does not fix it; persistent cursors/delta state or workload sharding must be implemented first. User Properties writes check estimated aggregate headroom, including retained generations and other user properties, before saving a new generation. Each round records bounded, content-free `durationMs`, `urlFetchCalls`, and `stateSaveCalls` metrics. The current [engineering audit](audit.md) records the final local verification.

## Cross-list move notes

Google-origin movement intentionally creates a fresh provider task ID in the destination list. Before the destination POST, the script durably stores a UUID move journal; the same Microsoft task POST adds a `com.tasksTodoSync.move` open type extension containing that UUID. Only unresolved target lists use the documented `$expand=extensions($filter=id eq 'com.tasksTodoSync.move')` short-name query. Graph To Do can normalize the returned ID to `microsoft.graph.openTypeExtension.com.tasksTodoSync.move` or legacy `Microsoft.OutlookServices.OpenTypeExtension.com.tasksTodoSync.move`; recovery validates that exact two-value allowlist, the exact extension name, and UUID locally. Bare names, suffix matches, and other prefixes are rejected. A changed source, incomplete inventory, ambiguous marker, or multiple candidate stops safely.

Microsoft-origin movement normally arrives as a new Microsoft ID plus a missing old ID. If an existing deployment explicitly has `SYNC_ALLOW_DELETIONS=false`, sync creates the new Google counterpart but retains the old Google counterpart. With `SYNC_ALLOW_DELETIONS=true`, the first complete round creates the new counterpart and records the old one as missing; a later complete round normally retires the old counterpart. If Graph reports the same Microsoft task ID in a different list, the script keeps both sides unchanged and records `MOVE_MICROSOFT_SAME_ID_LIST_CHANGED`.

The move rebuilds only title, plain-text notes, date-only due date, and completion state. Microsoft-only reminders, importance, categories, recurrence, start dates, creation date, completion history, and other provider metadata are not preserved. `dryRunReport()` does not expand attachment, checklist, linked-resource, or extension relationships, so those details are uninspected rather than absent.

## Move-journal operations runbook

Use this only when `healthCheck()` reports blocked or legacy task-move journals. These helpers never create, update, or delete a Google or Microsoft task; provider mutation remains deferred to a later `syncAll()` after another complete verification.

1. Run `deleteSyncTriggers()` and verify no sync execution is active. Preserve `exportRawSyncState()` privately.
2. Run `inspectTaskMoveJournals()`. It returns deterministic opaque `journalRef` and `revision` values, bounded reasons, phases, and evidence flags; it does not return provider IDs, task content, or correlation UUIDs.
3. Set Script Property `SYNC_TASK_MOVE_OPERATION_JSON` to a JSON object such as:

   ```json
   {"action":"resume","journalRef":"moveJournal_…","revision":"moveRevision_…"}
   ```

   Supported actions are `resume`, `cancel`, and `reconcile`. `reconcile` requires the exact candidate and confirmation returned by preview; never paste raw provider IDs.
4. Run `previewTaskMoveJournalOperation()`. Copy its opaque `previewToken` only when the intended operation reports `ok=true`; changing any effect-bearing field requires another preview.
5. Run `applyTaskMoveJournalOperation()`. It takes the global lock, rejects an active sync fence, rereads related Google/Microsoft data, validates the exact intent and live evidence, and requires a private before-image receipt read-back before changing one local journal. It never performs provider mutation.
6. Run `inspectTaskMoveJournals()` and `healthCheck()` again, review the result, and then run one manual `syncAll()` before recreating the 10-minute trigger.

Never clear `taskMoveJournal`, edit provider IDs, force-import state, or use cancel as blind cleanup. `MOVE_VS_EDIT_CONFLICT`, missing-source, changed-source, and ambiguous-winner situations remain fail closed unless the live evidence meets one exact operation.

## Low-level `clasp` fallback details

The productized command wraps this sequence. Use it only when inspecting or recovering a private project manually:

1. Enable the Apps Script API in Apps Script user settings and authenticate with the pinned clasp package:

   ```bash
   npx --yes @google/clasp@3.4.0 login
   ```

2. If this folder has no `.clasp.json`, make a private backup and create a standalone project:

   ```bash
   npx --yes @google/clasp@3.4.0 create --title "Tasks-ToDo Sync staging" --type standalone
   ```

   If `.clasp.json` already exists, verify that it names the intended private project and preserve a private backup before changing it.

3. Pull and compare before writing, then push only the reviewed exact sources:

   ```bash
   npx --yes @google/clasp@3.4.0 pull
   npx --yes @google/clasp@3.4.0 push
   ```

   `pull` can overwrite local source. Use a private backup or separate checkout for comparison, and do not use a delete-unused-files option during a recovery.

## Explicit list pairing (advanced)

New personal projects should use `auto`. For an existing deployment requiring fully manual pairing, set `SYNC_LIST_DISCOVERY_MODE=explicit`, configure `SYNC_GOOGLE_LIST_IDS` and optionally `SYNC_LIST_PAIRS_JSON`, then use the documented validation/apply functions in the Apps Script editor. Explicit pairing never guesses from titles. Stop the trigger and preserve state privately before changing modes.

## Rollback is two different operations

### Source rollback

1. Run `deleteSyncTriggers()` first, so no new sync starts while investigating.
2. Preserve the current Code/manifest and execution evidence privately.
3. Restore source from a known-good private backup or immutable Apps Script version. A trigger runs the project head, so an older version must be carefully brought back to the head before resuming. With `clasp`, retrieve an old version into a separate backup working copy using `pull --versionNumber`, compare it, and push only the reviewed `Code.gs` and `appsscript.json` to the intended project.
4. Run `setupStatus()` and `dryRunReport()` before creating a new trigger.

Do not depend on a Git tag that may not exist. Keep private source/version records before each staging change.

### Sync-state rollback

Source rollback does not roll back mappings, tombstones, move/deletion journals, or OAuth state. First export and retain state privately with `inspectSyncState()` and `exportRawSyncState()`. `restorePreviousSyncState()` refuses an active sync-round fence, active task move/deletion/list-deletion journals, and loss of tombstone evidence. It restores only a separately committed successful generation, never an intra-round checkpoint. After upgrading, complete and verify at least one successful sync before relying on restore; legacy state without a verifiable successful generation fails closed. Never clear properties or force-import state merely to bypass those safeguards. After any state restore, run `dryRunReport()` and manually review before resuming.

## v0.1.3 release readiness check

- [ ] `npm run check` and `npm test` pass locally, including the round-fence, restore, rich-body, bounded-auth/error, pagination, storage, and metrics coverage.
- [ ] CI passes on Node.js 22 and 24.
- [ ] The `npx tasks-todo-sync init` flow has been exercised from the packed package in a disposable private project, the printed editor URL was opened, and `initializeSafeDefaults()` was run in the editor; or the manual fallback has been followed and checked.
- [ ] The project time zone is the operator's intended IANA value, and the CLI output includes the editor URL and post-deploy steps.
- [ ] `setupStatus()` shows `auto`, task/list deletion `true`, and task moves `true` for a fresh project; existing explicit properties are recorded and preserved.
- [ ] Microsoft Entra registration, client secret, redirect URI, and OAuth authorization were completed manually and remain private.
- [ ] Two staging `syncAll()` runs are understood and have no unexpected duplicates.
- [ ] `dryRunReport()` warnings, exclusions, faults, and list information are understood; it has not been mistaken for a mutation plan.
- [ ] Bidirectional real-account validation covers recoverable task and list deletion evidence; it is not treated as universal safety evidence.
- [ ] Cross-list moves are enabled by default for fresh projects; bidirectional real-account validation is recorded without treating it as universal safety evidence, and the delete-and-recreate metadata boundary is understood.
- [ ] Source and state rollback procedures are documented separately, including the successful-generation restore boundary, and the operator understands the risks and limits of each.
- [ ] Private vulnerability reporting is enabled before public use.

Passing this list establishes release readiness for the documented `v0.1.3` scope. Publishing the package, tag, and GitHub release remains a separate step.
