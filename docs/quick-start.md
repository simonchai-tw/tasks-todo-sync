# Quick start (personal deployment)

This is the shortest path for one person. The synchronizer runs in a private Google Apps Script project; it is not a hosted multi-user service. Use one Google account and one Microsoft account, and authorize each provider separately. For complete operational procedures, see the [deployment guide](deployment.md); for evidence and limits, see the [engineering audit](audit.md).

## 1. Create the private Apps Script project

Run:

```bash
npx tasks-todo-sync init
```

The CLI creates a private standalone Apps Script project, applies the computer's IANA time zone (or `--timezone <IANA>`), pushes the release sources, and prints the editor URL. Open that URL and run `initializeSafeDefaults()` in the Apps Script editor. The CLI does not open the editor, execute Apps Script functions, write Script Properties, or accept Microsoft credentials. If `npx` cannot resolve the published package, use the [manual fallback](deployment.md#manual-apps-script-fallback).

Fresh projects receive:

```properties
SYNC_LIST_DISCOVERY_MODE=auto
SYNC_ALLOW_DELETIONS=true
SYNC_ALLOW_LIST_DELETIONS=true
SYNC_ALLOW_TASK_MOVES=true
```

Existing explicit Script Properties are preserved. Google Tasks due dates are date-only; choose the project time zone deliberately because a Microsoft due-time component does not round-trip.

## 2. Register Microsoft OAuth

In Microsoft Entra admin center, register an application for the Microsoft account you will connect:

- Choose personal-account sign-in, or organization-and-personal only when both are required.
- Add delegated Microsoft Graph permission `Tasks.ReadWrite` only. Do not add application permissions or `User.Read`; the program requests `offline_access` as part of OAuth.
- Create a client secret and copy its **Value**, not its ID. If the tenant UI or policy offers a 24-month expiry, choose it and set a private calendar reminder 30 days before expiry; follow [secret rotation](deployment.md#rotate-a-microsoft-client-secret) when it is due.

In Apps Script **Project Settings → Script Properties**, add `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, and optionally `MS_TENANT_ID` and `ALERT_EMAIL`. Run `showRedirectUri()`, add the displayed address under Entra **Authentication → Web → Redirect URI**, then run `startAuthorization()` and open its URL to sign in.

## 3. Inspect, validate, and schedule

1. Run `setupStatus()` and resolve unexpected configuration or authorization issues. A first Google consent screen may require **Advanced → Go project → Allow**; managed accounts may require administrator approval.
2. Run `dryRunReport()` and review warnings, exclusions, faults, lists, and any `pendingMoves[]` entries. This report is read-only.
3. Create a small disposable test list and run `syncAll()` twice. Confirm pairing and the expected deletion safeguards.
4. Run `createTrigger()` and use `healthCheck()` to confirm the 10-minute schedule.

Cross-list moves use a destination-first replacement: the new counterpart is created and verified under a durable recovery journal before the old counterpart is retired. Provider IDs change, and provider-only metadata without a cross-platform equivalent may not transfer. The deployment guide documents the move preview, recovery controls, and rollback procedure.

Ordinary changes normally appear within 0–10 minutes; operations requiring two complete confirmation rounds normally settle within 10–20 minutes. A time-budget exit starts a complete inventory on the next trigger. For rollback, explicit pairing, deletion validation, or operational recovery, use the [deployment guide](deployment.md).
