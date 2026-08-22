# Deployment guide — `0.1.0-rc.5`

## Scope and release boundary

This guide deploys a personal Google Apps Script sync engine. The 15-minute Apps Script trigger is the running service; GitHub is source control only. `0.1.0-rc.5` is an observability-focused prerelease candidate, not stable or production-ready.

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
4. Run `createTrigger()` only after the staging results are acceptable. It creates the 15-minute `syncAll` trigger.
5. After it runs, use `healthCheck()` and `setupStatus()` to check health and trigger state.

Do not enable destructive switches to test them against valuable data. Google-origin cross-list movement intentionally creates a fresh provider task ID in the destination list, durably records the create result, rereads the old source, then retires the old mapping and tombstones the old counterpart ID for 30 days. It needs `SYNC_ALLOW_TASK_MOVES=true`, not general deletion propagation. Microsoft-origin movement normally arrives as a new Microsoft ID plus a missing old ID; full convergence in that direction additionally needs `SYNC_ALLOW_DELETIONS=true`.

The move rebuilds only title, plain-text notes, date-only due date, and completion state. Microsoft-only reminders, importance, categories, recurrence, start dates, creation date, completion history, and other provider metadata are not preserved. If the Microsoft source changed, the post-create source reread differs, recovery has multiple exact candidates, or required inventory is incomplete, the operation stops without deleting the source. An interrupted run may therefore leave a temporary duplicate that requires recovery or review, but it must not prefer deletion over uncertain evidence. See [the RC5 disposable-list runbook](e2e-validation.md) for a controlled validation sequence.

`hasAttachments=true` is an observable hint in the Microsoft task snapshot. The current inventory does not expand attachment, checklist, linked-resource, or extension relationships, so `pendingMoves[]` reports those relationship details as uninspected rather than absent.

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
- [ ] A 15-minute trigger and `healthCheck()` have been checked in staging.
- [ ] Source and state rollback procedures are documented separately, and the operator understands the risks and limits of each.
- [ ] Private vulnerability reporting is enabled in the GitHub Security tab before public use.

Passing this list permits a public RC only. It does not establish stability or production readiness.
Actual source-rollback and sync-state-rollback drills remain separate blockers before a stable release; they are not claimed as completed by this RC gate.
