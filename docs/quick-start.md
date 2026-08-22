# Quick start (personal staging only)

This is the shortest safe path for one person. It creates a personal staging sync, not a production deployment.

There is **no public one-click Apps Script template** and no login-only setup yet. Every user must create their own Microsoft Entra app registration, use their own client secret, and sign in to both Google Apps Script and Microsoft OAuth.

## 1. Create a private Apps Script project

1. Create a new standalone project at [script.google.com](https://script.google.com/), open the editor, and enable the `appsscript.json` manifest in Project Settings.
2. Copy this repository's `Code.gs` and `appsscript.json` into that project. Before saving the manifest, replace its `timeZone` with your own IANA time zone, such as `Europe/London` or `America/Toronto`; do not copy `Asia/Taipei` unless it is actually yours.
3. Run `initializeSafeDefaults()` and complete the Google Apps Script authorization prompt. This sets the safe defaults: auto discovery plus all three dangerous-feature switches set to `false`.

Google Tasks due dates are date-only. The Microsoft due-time component is not preserved, so choose the project time zone deliberately and do not expect a time-of-day round trip.

## 2. Create your own Microsoft sign-in app

In Microsoft Entra admin center, register an application for your own account:

- For a personal Microsoft account only, choose the personal-account sign-in audience. If you genuinely need both organization and personal accounts, choose the organization-and-personal audience. This choice is about who can sign in, not Azure billing.
- Add Microsoft Graph **Delegated** permission `Tasks.ReadWrite` only. Do not add application permissions or `User.Read`; `offline_access` is requested by the program's OAuth scope.
- Create a client secret and copy its **value**. Never publish it or reuse someone else's secret.

In Apps Script **Project Settings → Script Properties**, add:

| Key | Value |
| --- | --- |
| `MS_CLIENT_ID` | Your Entra Application (client) ID |
| `MS_CLIENT_SECRET` | Your new client-secret value |
| `MS_TENANT_ID` | Optional; leave unset to use `common`, or use your intended tenant setting |
| `ALERT_EMAIL` | Optional private alert address |

Then run `showRedirectUri()`. Copy the displayed address to Entra **Authentication → Add a platform → Web → Redirect URI**.

## 3. Authorize and test before scheduling

1. Run `startAuthorization()`, open its URL, and sign in to your Microsoft account.
2. Run `setupStatus()` and resolve every unexpected warning. It reports whether safety defaults, credentials, time zone, and trigger state are configured without showing secret values.
3. Run `dryRunReport()`. It reads the configuration and lists and previews detected Google-origin cross-list moves. Review its structured `pendingMoves[]` entries, including blocked/recovery states and metadata that cannot be rebuilt. It remains a point-in-time report, not a guarantee about later mutations; `hasAttachments=true` may be observed, while attachment contents and other unexpanded relationships are reported as uninspected.

### Read this before the first automatic sync

With auto discovery, the project can contact **every eligible list in both accounts**, not just a list you recently created. A separate Apps Script project is not a data sandbox: if it uses the same accounts and credentials, it can still touch the same real lists. Tasks with the same content on both sides are not merged by content, so the first sync can leave two tasks.

For a low-risk trial, use a separate test account. If that is not possible, limit the scope first with `SYNC_EXCLUDED_LIST_NAMES` or explicit ID-based pairing. Read and understand every first-sync union warning in `dryRunReport()` before running `syncAll()`; do not treat the report as permission to proceed blindly.

4. Use disposable tasks within the deliberately limited scope and run `syncAll()` twice. Check the second run does not create unexpected duplicates.
5. Only after that, run `createTrigger()` and later `healthCheck()` to confirm the 15-minute schedule is healthy.

Keep `SYNC_ALLOW_DELETIONS=false`, `SYNC_ALLOW_LIST_DELETIONS=false`, and `SYNC_ALLOW_TASK_MOVES=false` until disposable-data testing is complete. A Google-origin cross-list move is independently enabled by `SYNC_ALLOW_TASK_MOVES=true`: the script creates the new Microsoft counterpart first, durably records its progress, then retires the old counterpart only after a fresh source check. A Microsoft-origin move normally appears through Graph as a new task plus a missing old task, so complete Microsoft → Google convergence still depends on `SYNC_ALLOW_DELETIONS=true`.

Delete-and-recreate changes the provider task ID. Only title, plain-text notes, date-only due date, and completion state are rebuilt; reminders, importance, categories, recurrence, attachments, creation date, and completion history are not preserved. Test this with a disposable task before enabling it for important lists.

`hasAttachments=true` can be detected from the Microsoft task snapshot, but attachment contents and other Graph relationships are not expanded by this release. Treat those details as uninspected.

For rollback, explicit list pairing, the disposable-list validation sequence, or the optional Node/`clasp` path, use the [deployment guide](deployment.md).
