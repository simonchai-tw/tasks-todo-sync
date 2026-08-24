# Deployment guide — `0.1.0-rc.6`

## Scope and release boundary

This guide deploys a personal Google Apps Script sync engine. The 10-minute Apps Script trigger is the running service; GitHub is source control only. `0.1.0-rc.6` is a recovery-safety prerelease candidate, not stable or production-ready.

Use a private staging project and disposable tasks first. The code can create counterpart lists/tasks during normal syncing. Keep all three safety switches `false` until destructive smoke testing is complete. Google-origin cross-list movement is independently controlled by the move switch; Microsoft-origin convergence uses the ordinary new-task plus missing-task deletion path.

There is no public Apps Script copy/template yet. The manual Apps Script route below is the supported first path. The optional `clasp` route is for people who already use Node.js and source control.

## What you need

- A Google account that can use Google Tasks and Apps Script.
- A Microsoft account and permission to register an Entra application for it.
- No Azure pay-as-you-go subscription, VM, database, or other Azure runtime resource. Entra's account-type choice is a sign-in audience, not a chargeable hosting choice.
- Node.js **22 or later** only if using local checks or the advanced `clasp` route.

Google Apps Script authorization and Microsoft OAuth are separate sign-ins. There is no shared credential or login-only configuration.

## Manual Apps Script deployment (recommended)

### 1. Create a private staging project

1. Create a standalone project at [script.google.com](https://script.google.com/).
2. In Project Settings, enable display of the `appsscript.json` manifest.
3. Copy this repository's `Code.gs` and `appsscript.json` into the project. Change `appsscript.json`'s `timeZone` to your own IANA time zone before saving; do not inherit `Asia/Taipei` unless it is correct for you.
4. Run `initializeSafeDefaults()` and complete the Google authorization prompts. It sets `SYNC_LIST_DISCOVERY_MODE=auto` and sets the three safety switches to `false` without overwriting unrelated Script Properties.

Google Tasks due dates are date-only. Microsoft due times are not preserved, so changing the project time zone affects date interpretation but does not create time-of-day round trips.

### 2. Register Microsoft OAuth for yourself

In Microsoft Entra admin center, create an application registration:

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
| `SYNC_LIST_DISCOVERY_MODE` | Yes | `auto` |
| `SYNC_EXCLUDED_LIST_NAMES` | No | List names to exclude, one per line or comma-separated |
| `SYNC_ALLOW_DELETIONS` | Yes | `false` |
| `SYNC_ALLOW_LIST_DELETIONS` | Yes | `false` |
| `SYNC_ALLOW_TASK_MOVES` | Yes | `false` |

Never put these values, OAuth tokens, raw state, or IDs in the repository, issues, or screenshots.

### 3. Set the Web redirect URI and authorize

1. Run `showRedirectUri()` and copy the URL from the execution log.
2. In Entra, open **Authentication**, choose **Add a platform**, choose **Web**, and add that exact URL as a redirect URI.
3. Run `startAuthorization()`, open the returned URL, and sign in with the intended Microsoft account.
4. Run `setupStatus()` and resolve unexpected warnings. It reports readiness without showing credential values.

### 4. Verify before adding the schedule

1. Run `dryRunReport()` and review its warnings, exclusions, faults, list information, and `pendingMoves[]` entries. Each move entry should identify the mapped and target lists, its execution state, and metadata that is known to be left behind by delete-and-recreate. It is read-only and point-in-time; it is **not** a guarantee about later mutations. Attachments, checklist items, linked resources, and extensions are relationships that the current inventory does not expand, so the report must not claim that they are absent.
2. With disposable tasks, run `syncAll()` twice and inspect both services. The second run should not make unexpected duplicates.
3. Exercise only non-destructive behavior you understand: create, update, complete, and date-only due-date handling.
4. Run `createTrigger()` only after the staging results are acceptable. It deletes earlier `syncAll` triggers and creates one 10-minute trigger. Existing deployments must rerun it after upgrading from rc.5.
5. After it runs, use `healthCheck()` and `setupStatus()` to check health and trigger state.

Do not enable destructive switches to test them against valuable data. Google-origin cross-list movement intentionally creates a fresh provider task ID in the destination list. Before the POST it durably stores a UUID move journal; the same Microsoft task POST adds a `com.tasksTodoSync.move` open type extension containing that UUID. Only unresolved target lists use the documented `$expand=extensions($filter=id eq 'com.tasksTodoSync.move')` short-name query. Graph To Do can normalize the returned ID to `microsoft.graph.openTypeExtension.com.tasksTodoSync.move` or legacy `Microsoft.OutlookServices.OpenTypeExtension.com.tasksTodoSync.move`; recovery validates that exact two-value allowlist, the exact extension name, and UUID locally, rejecting bare names, suffix matches, and other prefixes. It rereads the old source, then retires the old mapping and tombstones the old counterpart ID for 30 days. This path needs `SYNC_ALLOW_TASK_MOVES=true`, not general deletion propagation.

Microsoft-origin movement normally arrives as a new Microsoft ID plus a missing old ID. With `SYNC_ALLOW_DELETIONS=false`, sync creates the new Google counterpart but intentionally retains the old Google counterpart, so the two tasks can remain indefinitely. With `SYNC_ALLOW_DELETIONS=true`, the first complete round creates the new counterpart and records the old one as missing; a later complete round normally retires the old counterpart. Expect a temporary duplicate for roughly one additional cadence. If Graph ever reports the same Microsoft task ID in a different list, the script keeps both sides unchanged and records `MOVE_MICROSOFT_SAME_ID_LIST_CHANGED`.

The move rebuilds only title, plain-text notes, date-only due date, and completion state. Microsoft-only reminders, importance, categories, recurrence, start dates, creation date, completion history, and other provider metadata are not preserved. Interrupted recovery accepts only one unmapped destination in the intended list whose extension ID is one of the two exact service-normalized identities and whose exact extension name, valid matching UUID, and synchronized-field fingerprint also match. A same-content task without the marker is not adopted; multiple exact markers, an edited marker task, an unreadable extension inventory, or a changed source stops without deleting the source. See [the RC6 disposable-list runbook](e2e-validation.md) for a controlled validation sequence.

`hasAttachments=true` is an observable hint in the Microsoft task snapshot. `dryRunReport()` does not expand attachment, checklist, linked-resource, or extension relationships, so `pendingMoves[]` reports those relationship details as uninspected rather than absent. During `syncAll()`, only Microsoft target lists with unresolved correlated move journals receive an extension expansion; normal lists do not, and there is no per-task N+1 read.

## Runtime cadence and capacity boundary

Google Apps Script enforces a six-minute limit for one execution. The script's own `RUN_LIMIT_MS` is 5.25 minutes, leaving 45 seconds before the platform ceiling. Destructive task, list, and move journal paths reserve another 45 seconds inside that internal budget and fail fast before live revalidation, durable journal writes, or remote deletion; the existing durable journal remains for the next full-inventory run. Ten minutes is the first supported Apps Script minute-trigger cadence above the platform ceiling. A global lock skips an overlapping invocation instead of running two syncs concurrently.

- Ordinary changes normally appear in 0–10 minutes.
- A two-complete-round deletion or Microsoft-origin old-task cleanup normally converges in 10–20 minutes.
- Throttling, authorization failure, an incomplete inventory, or a skipped overlapping trigger can make either longer.

Time-budget recovery does not resume a partially fetched page set. Neither the Google nor Microsoft inventory stores a page cursor, delta token, or shard checkpoint. The next trigger begins a complete inventory again. If one full inventory consistently takes more than 5.25 minutes, a 15-minute trigger does not fix it; persistent cursors/delta state or workload sharding must be implemented first.

## Move-journal operations runbook

Use this only when `healthCheck()` reports blocked or legacy task-move journals. These helpers never create, update, or delete a Google or Microsoft task; provider mutation remains deferred to a later `syncAll()` after another complete verification.

1. Run `deleteSyncTriggers()` and verify no sync execution is active. Preserve `exportRawSyncState()` privately.
2. Run `inspectTaskMoveJournals()`. It returns deterministic opaque `journalRef` and `revision` values, bounded reasons, phases, and evidence flags; it does not return provider IDs, task content, or correlation UUIDs.
3. Set Script Property `SYNC_TASK_MOVE_OPERATION_JSON` to a JSON object such as:

   ```json
   {"action":"resume","journalRef":"moveJournal_…","revision":"moveRevision_…"}
   ```

   Supported actions are:

   - `resume`: only when Google remains at the intended target with the original synchronized fields, the old Microsoft source is unchanged, the mapping and inventories are complete, and no ambiguous marker exists. It clears bounded block/recovery fields only.
   - `cancel`: only after the operator has manually returned the Google task to its original mapped list, no destination ID or candidate exists, the old Microsoft source is unchanged, and both mapping directions still agree. It removes that one journal and its move conflict only.
   - `reconcile`: adopts one exact destination into the journal only. A correlated journal requires its exact marker and fingerprint. A legacy journal requires a `candidateRef` from preview plus `"confirmation":"ADOPT_EXACT_DESTINATION"`; its candidate must be unmapped, in the target list, fingerprint-exact, and inside the legacy creation window.

4. Run `previewTaskMoveJournalOperation()`. For legacy reconcile, copy the opaque `candidateRef` and exact confirmation text into the property, then run preview again. When the intended operation reports `ok=true`, copy its `previewToken` without changing the action, journal reference/revision, candidate reference, or confirmation. Any such change requires another preview. Do not paste raw IDs.
5. Run `applyTaskMoveJournalOperation()`. It takes the global lock, rejects an active sync fence, loads strict state, rereads the related Google/Microsoft data, and verifies that the token matches both the exact operation intent and live evidence. It then serializes a private User Properties before-image receipt and requires an exact read-back before changing one local journal. If receipt storage is stale, missing, or mismatched, no journal changes.
6. Run `inspectTaskMoveJournals()` and `healthCheck()` again. Review the result, then run one manual `syncAll()`; it independently rereads live state before any provider mutation. Recreate the 10-minute trigger only after the result is understood.

Never clear `taskMoveJournal`, edit provider IDs, force-import state, or use cancel as a blind cleanup. `MOVE_VS_EDIT_CONFLICT`, missing-source, changed-source, and ambiguous-winner situations should remain fail closed unless the live evidence meets one of the exact operations above.

## Optional advanced `clasp` route

Use this route only after completing the manual flow or when you already maintain a local Apps Script checkout.

1. Install Node.js 22 or later and run local checks:

   ```bash
   npm run check
   npm test
   ```

2. Enable the Apps Script API in your Apps Script user settings, then authenticate:

   ```bash
   npx --yes @google/clasp@3.3.0 login
   ```

3. If this folder has **no** `.clasp.json`, make a private backup of the folder, then create a new project with the verified `clasp` v3 command:

   ```bash
   npx --yes @google/clasp@3.3.0 create-script --title "Tasks-ToDo Sync staging" --type standalone
   ```

   If `.clasp.json` already exists, it is bound to an existing Apps Script project: do **not** run `create-script`. First verify that project is the intended staging project and make a private backup/version of its current source.

4. This repository's `.claspignore` deliberately allows only `Code.gs` and `appsscript.json` to be pushed. Pull and compare before writing, then push only after the comparison is understood:

   ```bash
   npx --yes @google/clasp@3.3.0 pull
   npx --yes @google/clasp@3.3.0 push
   ```

   `pull` can overwrite local source. Use a private backup or a separate checkout for the comparison; do not use its delete-unused-files option during this RC.

## Explicit list pairing (advanced)

New personal projects should use `auto`. For an existing deployment requiring fully manual pairing, set `SYNC_LIST_DISCOVERY_MODE=explicit`, configure `SYNC_GOOGLE_LIST_IDS` and optionally `SYNC_LIST_PAIRS_JSON`, then use the documented validation/apply functions in the Apps Script editor. Explicit pairing never guesses from titles. Stop the trigger and preserve state privately before changing modes.

## Rollback is two different operations

### Source rollback

1. Run `deleteSyncTriggers()` first, so no new sync starts while investigating.
2. Preserve the current Code/manifest and execution evidence privately.
3. Restore source from a known-good private backup or from a known-good immutable Apps Script version. A trigger runs the project head, so an older version must be carefully brought back to the head before resuming. With `clasp`, retrieve an old version into a **separate backup working copy** using `pull --versionNumber`, compare it, then push only the reviewed `Code.gs` and `appsscript.json` to the intended project.
4. Run `setupStatus()` and `dryRunReport()` before creating a new trigger.

Do not depend on a Git tag that may not exist. Keep private source/version records before each staging change.

### Sync-state rollback

Source rollback does not roll back mappings, tombstones, move/deletion journals, or OAuth state. First export/retain state privately with `inspectSyncState()` and `exportRawSyncState()`. `restorePreviousSyncState()` is deliberately limited: it refuses an active sync-round fence, refuses active task move/deletion/list-deletion journals, and preserves deletion/tombstone evidence. Never clear properties or force-import state merely to bypass those safeguards. After any state restore, run `dryRunReport()` and manually review before resuming.

## RC release gate

- [ ] `npm run check` and `npm test` pass locally.
- [ ] CI passes on Node.js 22 and 24.
- [ ] `initializeSafeDefaults()` and `setupStatus()` show the expected safe configuration.
- [ ] `SYNC_ALLOW_DELETIONS=false`, `SYNC_ALLOW_LIST_DELETIONS=false`, and `SYNC_ALLOW_TASK_MOVES=false` remain set.
- [ ] Two staging `syncAll()` runs are understood and have no unexpected duplicates.
- [ ] `dryRunReport()` warnings, exclusions, faults, and list information are understood; it has not been mistaken for a mutation plan.
- [ ] `pendingMoves[]` output has been checked for deterministic ordering, blocked and recovery states, and honest metadata detection. Unexpanded Graph relationships are not described as absent.
- [ ] A 10-minute trigger and `healthCheck()` have been checked in staging; an rc.5 deployment has rerun `createTrigger()`.
- [ ] Source and state rollback procedures are documented separately, and the operator understands the risks and limits of each.
- [ ] Private vulnerability reporting is enabled in the GitHub Security tab before public use.

Passing this list permits a public RC only. It does not establish stability or production readiness.
Actual source-rollback and sync-state-rollback drills remain separate blockers before a stable release; they are not claimed as completed by this RC gate.
