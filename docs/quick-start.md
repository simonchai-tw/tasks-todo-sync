# Quick start (personal deployment)

This is the shortest path for one person. The synchronization service runs in your private Google Apps Script project; it is not a hosted multi-user service.

For the current release history and verification boundary, see the [changelog](../CHANGELOG.md) and [engineering audit](audit.md).

> **Accounts required:** Use one Google account and one Microsoft account. You authorize both during setup. Google `clasp`/Apps Script authorization and Microsoft OAuth can each show their own sign-in or consent pages, so the exact number of prompts depends on your existing sessions.

## 1. Create the private Apps Script project

The `v0.1.3` productized flow is:

```bash
npx tasks-todo-sync init
```

The CLI defaults to this computer's resolved IANA time zone. Pass `--timezone <IANA>` to override it. It uses `clasp` to create a private standalone Apps Script project, applies the selected time zone to the manifest, pushes the exact `Code.gs` and `appsscript.json` sources, and prints the editor URL with the remaining post-deploy steps.

The CLI deploys the source and prints the remaining steps. It does not open the editor, execute Apps Script functions, or write Script Properties. Open the printed editor URL and run `initializeSafeDefaults()` there. The CLI never accepts or stores `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, `MS_TENANT_ID`, OAuth tokens, or any other Microsoft credential. If `npx` cannot resolve the published npm package, use the [manual fallback](deployment.md#manual-apps-script-fallback).

After `initializeSafeDefaults()` runs, fresh projects receive these values:

```properties
SYNC_LIST_DISCOVERY_MODE=auto
SYNC_ALLOW_DELETIONS=true
SYNC_ALLOW_LIST_DELETIONS=true
SYNC_ALLOW_TASK_MOVES=true
```

Existing explicit Script Properties are preserved. In particular, `init` does not rewrite a maintainer's private deployment whose three switches are already all `true`.

Google Tasks due dates are date-only. The Microsoft due-time component is not preserved, so choose the project time zone deliberately and do not expect a time-of-day round trip.

## 2. Register Microsoft OAuth manually

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

Then run `showRedirectUri()`. Copy the displayed address to Entra **Authentication → Add a platform → Web → Redirect URI**. Run `startAuthorization()`, open its URL, and sign in to your Microsoft account.

## 3. Inspect, then schedule

1. In the Apps Script editor, run `initializeSafeDefaults()` and complete any remaining Google authorization prompt. Then run `setupStatus()` and resolve every unexpected warning. It reports configuration, authorization, time zone, and trigger readiness without showing secret values.
2. Run `dryRunReport()`. Review its warnings, exclusions, faults, list information, and structured `pendingMoves[]` entries. The report is read-only and point-in-time; unexpanded Graph relationships are reported as uninspected, not absent.
3. Create a small test list you can inspect, then run `syncAll()` twice. Task and list deletion are enabled for fresh projects and have been verified in both directions; two-round confirmation, live revalidation, journals, and tombstones protect the deletion paths.
4. Run `createTrigger()` only after the first two rounds are understood, then use `healthCheck()` to confirm the 10-minute schedule.

If you use `restorePreviousSyncState()` after upgrading, first complete and verify a successful sync with the new version. Restore can select the current or previous successfully committed generation; it does not recover an arbitrary intra-round checkpoint. Legacy state without a verifiable successful generation fails closed.

Cross-list task moves are enabled for fresh projects and protected by a durable move journal and live revalidation. Movement uses delete-and-recreate semantics, so provider-only reminders, recurrence, importance, categories, attachments, and history may not be preserved. The deployment guide documents the move preview, metadata boundary, and recovery controls.

Apps Script allows one execution for at most six minutes. This project budgets 5.25 minutes and schedules every 10 minutes, so ordinary changes normally take 0–10 minutes and two-round cleanup about 10–20 minutes. Pagination has bounded page-token and page-count guards, and each run records privacy-bounded duration, URL-fetch, and state-save metrics. A time-budget exit starts a full inventory again on the next trigger; there is no saved page cursor, delta token, or shard checkpoint, so consistently oversized inventories need an architectural change rather than a longer trigger interval. Storage-headroom and metrics checks are recorded in the [engineering audit](audit.md).

Delete-and-recreate changes the provider task ID. Only title, plain-text notes, date-only due date, and completion state are rebuilt; reminders, importance, categories, recurrence, attachments, creation date, and completion history are not preserved during cross-list moves. A Google title, date, or completion-only edit does not rewrite an existing Microsoft rich-text body; a notes projection change does.

For explicit list pairing, rollback, the deletion smoke procedure, or the full manual fallback, use the [deployment guide](deployment.md).
