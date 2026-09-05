# Quick start (personal deployment)

This is the shortest path for one person. The synchronizer runs in a private Google Apps Script project; it is not a hosted multi-user service. Use one Google account and one personal Microsoft account, and authorize each provider separately. For complete operational procedures and the Advanced self-managed Entra option, see the [deployment guide](deployment.md). For evidence and limits, see the [engineering audit](audit.md).

Supported environment: initial installation and source updates require a Windows, macOS, or Linux desktop/laptop with Node.js 22+, a terminal, and a modern browser. Chromebook Linux is best effort. npm installation is not supported on phones; the Microsoft connection wizard remains mobile-responsive for reauthorization.

## 1. Create the private Apps Script project

Install Node.js 22 or later, open Terminal or PowerShell, and run:

```bash
npx tasks-todo-sync init
```

The CLI creates a private standalone Apps Script project, applies the computer's IANA time zone (or `--timezone <IANA>`), pushes the release sources, and prints the editor URL. Open that URL, select `initializeSafeDefaults` in the function list, and click **Run**. Approve the Google permission screen when prompted. The CLI does not receive Microsoft credentials or OAuth tokens. If `npx` cannot resolve the published package, use the [manual fallback](deployment.md#manual-apps-script-fallback).

Fresh projects receive:

```properties
SYNC_LIST_DISCOVERY_MODE=auto
SYNC_ALLOW_DELETIONS=true
SYNC_ALLOW_LIST_DELETIONS=true
SYNC_ALLOW_TASK_MOVES=true
```

Existing explicit Script Properties are preserved. Google Tasks due dates are date-only; choose the project time zone deliberately because a Microsoft due-time component does not round-trip.

## 2. Open your private setup page

In the Apps Script editor:

1. Click **Deploy → New deployment**.
2. Beside **Select type**, click the gear and choose **Web app**.
3. Set **Execute as** to **Me** and **Who has access** to **Only myself**.
4. Click **Deploy**, approve the Google permission screen if it appears, then open the displayed web-app URL.
5. On the private setup page, click **Connect**, then **Open Microsoft sign-in**. Microsoft's current Device Code page is `https://www.microsoft.com/link`; the project also accepts Microsoft's legacy `https://microsoft.com/devicelogin` and `https://www.microsoft.com/devicelogin` addresses. Continue only when the displayed HTTPS address exactly matches one of those official Microsoft URLs, enter the short code, and complete Microsoft consent. Return to the setup page and wait for it to confirm the connection.

The standard Personal Microsoft mode uses a shared public client ID. A client ID identifies an application; it is not a password or secret. No Microsoft client secret or redirect URI is needed. Your access and refresh tokens remain in your own Apps Script `UserProperties` and are not shown by the setup page.

Enter your Microsoft password only on an official Microsoft page. Tasks–To Do Sync and its Apps Script setup page never ask for that password.

If you already use `MS_CLIENT_ID` or `MS_CLIENT_SECRET`, the project keeps the existing Advanced Entra mode and does not migrate it. Follow [Advanced self-managed Entra authorization](deployment.md#advanced-self-managed-entra-authorization) instead.

## 3. Inspect, validate, and schedule

Return to the Apps Script editor:

1. Select `setupStatus` and click **Run**. Resolve unexpected configuration or authorization issues. A first Google consent screen may require **Advanced → Go to project → Allow**; managed accounts may require administrator approval.
2. Select `dryRunReport`, click **Run**, and review warnings, exclusions, faults, lists, and any `pendingMoves[]` entries. This report is read-only.
3. Create a small disposable test list, select `syncAll`, and click **Run** twice. Confirm pairing and the expected deletion safeguards.
4. Select `createTrigger`, click **Run**, then run `healthCheck` to confirm the 10-minute schedule.

Cross-list moves use a destination-first replacement: the new counterpart is created and verified under a durable recovery journal before the old counterpart is retired. Provider IDs change, and provider-only metadata without a cross-platform equivalent may not transfer. The deployment guide documents recovery and rollback.

Ordinary changes normally appear within 0–10 minutes; operations requiring two complete confirmation rounds normally settle within 10–20 minutes. A time-budget exit starts a complete inventory on the next trigger. For rollback, explicit pairing, deletion validation, or operational recovery, use the [deployment guide](deployment.md).
