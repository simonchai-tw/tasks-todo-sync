# Real-account E2E validation

This runbook validates Personal Microsoft Device Code authorization and cross-list moves with disposable Google Tasks and Microsoft To Do data. Run it against a private staging project, never valuable lists. Each scenario is repeatable: create fresh disposable lists and tasks, record only the bounded outcome privately, and remove disposable residue afterward.

Do not record or publish account addresses, passwords, authorization codes, OAuth responses, provider IDs, task content, raw state, Apps Script project IDs, or web-app URLs. Enter a Microsoft password only on an official Microsoft page. The Apps Script setup page never asks for it.

Supported environment: run installation and source updates on a Windows, macOS, or Linux desktop/laptop with Node.js 22+, a terminal, and a modern browser. Chromebook Linux is best effort. npm installation is not supported on phones; the Microsoft connection wizard remains mobile-responsive for reauthorization. Use the [field compatibility matrix](field-compatibility.md) when recording field results.

## A. Fresh Personal-mode installation

### Create and initialize the staging project

1. On a computer with Node.js 22 or later, open PowerShell or Terminal.
2. Run `npx tasks-todo-sync init --timezone <your-IANA-time-zone>`, replacing the placeholder with a value such as `Asia/Taipei` or `America/New_York`.
3. Open the Apps Script editor URL printed by the installer.
4. At the top of the editor, open the function list, choose `initializeSafeDefaults`, and click **Run**.
5. If Google shows **Authorization required**, click **Review permissions**, choose the disposable Google account, review the scopes, and click **Allow**. If an unverified-app screen appears, click **Advanced**, open the project, and continue only if the Apps Script project is the staging project you just created.
6. Open **Project Settings → Script Properties**. Confirm there is no `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, or manually entered OAuth token. Do not add one for this scenario.
7. Return to **Editor**, choose `setupStatus`, click **Run**, and inspect the execution result. Confirm it selects Personal mode and reports that Microsoft authorization is required. Do not publish the full result.

### Deploy the private setup page

1. Click **Deploy → New deployment**.
2. Beside **Select type**, click the gear and select **Web app**.
3. Enter `Private setup E2E` as the description.
4. Set **Execute as** to **Me**.
5. Set **Who has access** to **Only myself**.
6. Click **Deploy** and complete any Google permission prompt.
7. Copy and open the displayed **Web app URL** while signed in to the same disposable Google account. Do not share the URL.
8. Confirm the page identifies itself as a private setup page and does not contain fields for a Microsoft password, client secret, or redirect URI.

### Complete Device Code Flow

1. On the private setup page, click **Connect**.
2. Confirm the page displays only a short user code, an official Microsoft verification address, an expiry, and bounded status. The current endpoint is expected to return `https://www.microsoft.com/link`; Microsoft's legacy `https://microsoft.com/devicelogin` and `https://www.microsoft.com/devicelogin` are also accepted. It must not display an access token, refresh token, `device_code`, or raw OAuth response.
3. Leave the Microsoft page untouched for at least one polling interval. Confirm the setup page remains pending and does not present the normal pending state as an error.
4. Click **Cancel**. Confirm the pending code disappears. Because no authorization completed, `setupStatus` should still report that Personal authorization is required.
5. Start again and allow the displayed expiry to pass. Confirm the session reports expiry and requires a new code rather than continuing to poll or exposing a provider response. This step may take the full provider-specified expiry; record it separately if the validation window is limited.
6. Start a fresh session and open the displayed address. Before entering anything, confirm the HTTPS address exactly matches `https://www.microsoft.com/link`, `https://microsoft.com/devicelogin`, or `https://www.microsoft.com/devicelogin`. Do not continue from a lookalike domain, a URL supplied outside the private setup page, or any other address.
7. Enter the short code, sign in with the disposable personal Microsoft account, review the delegated permission, and approve it.
8. Return to the private setup page. Wait for it to report success; do not repeatedly start new sessions while one is pending.
9. Return to the Apps Script editor, choose `setupStatus`, and click **Run**. Confirm the Microsoft mode is Personal and authorization is present.
10. Open **Project Settings → Script Properties**. Confirm no `MS_CLIENT_SECRET` or redirect URI was added. Do not inspect, copy, or publish User Properties or OAuth token values.

Record this as real-account evidence only after every step succeeds. A unit test or fake-provider run is not a substitute.

### Consent revocation and reauthorization

1. Run `deleteSyncTriggers` in Apps Script so no scheduled sync runs during the test.
2. Open Microsoft's [Apps and services permissions](https://account.live.com/consent/Manage) page while signed in to the disposable Microsoft account. Find **Tasks–To Do Sync**, choose its details or edit action, and remove its permission. Microsoft can change the exact wording; verify the application name before revoking.
3. In Apps Script, run `healthCheck` or a small manual `syncAll`. Confirm synchronization stops with a bounded Personal-reauthorization result and does not print OAuth tokens or the raw Microsoft response.
4. Open the private setup page and complete Device Code Flow again.
5. Run `setupStatus`, then a small manual `syncAll`. Confirm authorization and synchronization recover without recreating mappings or entering a client secret.
6. Run `createTrigger` after the scenario if scheduled testing will continue.

## B. Advanced-mode compatibility

Run this only in a separate staging project that already has working self-managed Entra credentials.

1. In **Project Settings → Script Properties**, confirm the private project contains its intended `MS_CLIENT_ID` and `MS_CLIENT_SECRET`. Do not copy their values into the test record.
2. Upgrade the source, then run `setupStatus`. Confirm it resolves to Advanced mode and does not request Personal migration.
3. Run a small `syncAll` and confirm the existing Advanced authorization still works.
4. Begin a Personal authorization session but cancel it before Microsoft approval. Confirm `setupStatus` still reports Advanced mode and the existing Script Properties remain present.
5. Do not use `forgetPersonalMicrosoftAuthorization()` as a general reset; it intentionally removes Personal tokens only and does not manage Advanced credentials.

## C. Cross-list moves

### Preconditions

1. Complete the [quick start](quick-start.md) in a private staging project and confirm `SYNC_ALLOW_TASK_MOVES=true` with `setupStatus()`.
2. Create two eligible lists on each provider and let automatic pairing settle. Do not use shared, non-owned, excluded, or special lists.
3. Run `syncAll()` twice, then run `dryRunReport()`. Save the report privately; do not share provider IDs, task content, or raw state.
4. Create one disposable task in a paired Google list and one in a paired Microsoft list. Record their initial counterpart relationships privately.

### Google-origin move: create, verify, retire

1. Move the disposable Google task to the other Google list.
2. Run `dryRunReport()`. Observe one move candidate and its bounded `pendingMoves[]` evidence; the report is read-only.
3. Run one complete `syncAll()`.
4. Verify that the Microsoft counterpart now appears in the paired destination list, the old Microsoft counterpart is no longer in the source list, and no duplicate was created. Its provider ID is expected to change.
5. Run `syncAll()` again and confirm the result remains one mapped counterpart with no repeated create or delete.
6. If source evidence changed, inventory was incomplete, or marker evidence was ambiguous, confirm a fail-closed result and retained journal rather than a guessed retirement. Resolve only through the [move-journal operations runbook](deployment.md#move-journal-operations-runbook).

The live-account check validates convergence. Automated and fault-injection coverage verifies the internal order: durable journal → destination create → destination read-back and live verification → old counterpart retirement. Provider-only metadata without a cross-platform equivalent may not transfer.

### Microsoft-origin move: counterpart creation, then two-round retirement

1. Set `SYNC_ALLOW_DELETIONS=false` and move the disposable Microsoft task to the other Microsoft list.
2. Run one complete `syncAll()` and verify a new Google counterpart is created while the old Google counterpart remains. This residue is intentional when deletion is disabled.
3. Set `SYNC_ALLOW_DELETIONS=true` and run one complete `syncAll()`. Observe the first missing-old observation and retained deletion evidence.
4. Run a later complete `syncAll()` and verify the ordinary two-round deletion confirmation and live revalidation retire the old Google counterpart. Confirm the new counterpart remains mapped.
5. If the same Microsoft task ID is reported in another list, verify `MOVE_MICROSOFT_SAME_ID_LIST_CHANGED` and no silent remapping. Restore the intended setting after the scenario.

The Microsoft-origin order is: new Google counterpart creation → first missing-old observation → second complete confirmation round and live revalidation → old Google counterpart retirement.

### Blocked move

1. Set `SYNC_ALLOW_TASK_MOVES=false`.
2. Move a second disposable Google task between the two disposable Google lists.
3. Run `dryRunReport()` and `syncAll()`.
4. Verify the candidate is blocked, the old Microsoft task remains, and no destination Microsoft task is created.
5. Restore `SYNC_ALLOW_TASK_MOVES=true` before continuing.

## D. Supported-field matrix

Use new disposable tasks for each direction. After every change, run one complete `syncAll()` and inspect both provider UIs. Do not combine deletion or movement with a field case.

| Case | Google-origin check | Microsoft-origin check | Expected projection |
| --- | --- | --- | --- |
| Create | Create an incomplete task with title, multiline plain-text notes, and a due date | Create an incomplete task with title, notes, and a due date | One mapped counterpart with the same supported values |
| Title edit | Change only the title | Change only the title | New title reaches the counterpart |
| Notes edit | Change only plain-text notes | Change only notes, including simple rich formatting | Text reaches the counterpart; HTML formatting is not promised |
| Due-date edit | Change the date | Change the date and, if available, a time | Date reaches the counterpart; time of day does not round-trip |
| Complete | Mark incomplete task complete | Mark incomplete task complete | Counterpart becomes complete |
| Reopen | Reopen the completed task | Reopen the completed task | Counterpart becomes incomplete again |

For each row, record pass or fail for both directions and the bounded execution outcome. Microsoft reminders, recurrence, importance, categories, attachments, checklists, and other provider-only fields are outside the supported projection; do not record their absence as a supported-field failure.

### Concurrent edit observation

1. Choose one disposable mapped task and confirm both sides have converged.
2. Without running sync, enter different titles on Google and Microsoft and save both.
3. Run one complete `syncAll()`.
4. Confirm both sides converge to one value and the execution log records the bounded conflict winner. The engine uses provider server timestamps; small clock differences mean this exercise must not assume the edit made last by hand will always win.
5. Confirm the overwritten value is not represented as a backup, then restore a neutral disposable title.

## E. Rollback rehearsal

Run rollback only in the disposable staging project. It is an operational rehearsal, not part of ordinary setup.

1. Run `deleteSyncTriggers()` and wait for any active execution to finish.
2. Run `inspectSyncState()` and privately save `exportRawSyncState()`. Never paste the export into an issue or public log.
3. Complete one known-good `syncAll()` so the current deployment has a separately committed successful generation.
4. Make one harmless disposable task edit and complete another `syncAll()`.
5. Run `restorePreviousSyncState()`. Confirm it either restores the prior committed generation or fails closed with a bounded reason; it must not restore an intra-round checkpoint or proceed through an active mutation journal.
6. Run `dryRunReport()` before any further mutation. Confirm only the expected disposable difference is present, then run one complete `syncAll()` and `healthCheck()`.
7. Recreate the trigger with `createTrigger()` only after the staging state is understood.

For source rollback, preserve the current source and `.clasp.json`, push only a previously released compatible source revision to this same staging project, run `setupStatus()` and `dryRunReport()`, then restore the current source and complete one verified sync. Source rollback does not roll back mappings, tombstones, journals, or OAuth state.

## F. Fault-injection and recovery observations

The local fault-injection suite covers throttling-shaped failures, interrupted responses, duplicate prevention, exact marker identities, and journal recovery. It verifies that repeated HTTP 429 responses make exactly `HTTP_MAX_RETRIES + 1` attempts, that an exhausted move-create error retains the old source and persists a `creating` journal without an immediate duplicate, and that ambiguous or changed marker evidence is not adopted.

The local suite uses fake providers and a fake clock. It does not reproduce real provider throttling, Apps Script termination, or network timing. For a real-account interruption or concurrent edit, preserve the private journal, run `inspectTaskMoveJournals()`, and follow the deployment runbook; never clear the journal or edit provider IDs manually.

## G. Cleanup and record

After each scenario, run a final `dryRunReport()`, remove disposable tasks and lists manually where appropriate, and confirm a subsequent `syncAll()` has no unexpected candidates. Keep private notes of direction, observed ordering, whether deletion was enabled, and the bounded outcome. Do not publish raw state, task content, provider IDs, correlation UUIDs, or screenshots containing them.
