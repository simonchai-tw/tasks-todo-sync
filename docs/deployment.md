# Deployment guide

## Scope and release boundary

This guide is the operational source of truth for the personal Google Apps Script synchronizer. A private Apps Script trigger runs every 10 minutes; GitHub hosts the source and release history. Fresh projects enable automatic list discovery, task deletion, list deletion, and cross-list task moves. Existing explicit Script Properties are preserved. See the [changelog](../CHANGELOG.md) for history and the [engineering audit](audit.md) for evidence and limits.

Google and Microsoft authorization are separate sign-ins. The CLI deploys source only; Google consent, private web-app deployment, Microsoft authorization, and validation remain manual and private.

Supported environment: initial installation and source updates require a Windows, macOS, or Linux desktop/laptop with Node.js 22+, a terminal, and a modern browser. Chromebook Linux is best effort. npm installation is not supported on phones; the Microsoft connection wizard remains mobile-responsive for reauthorization. See the [field compatibility matrix](field-compatibility.md) for the canonical field boundary.

## Productized `init` flow

Use Node.js 22 or later:

```bash
npx tasks-todo-sync init
```

The CLI uses `clasp` to create a private standalone Apps Script project, apply the computer's IANA time zone (or `--timezone <IANA>`), push the exact release sources, and print the editor URL and remaining steps. Open the URL, select `initializeSafeDefaults`, and click **Run**. The CLI does not open the editor, execute Apps Script functions, write Script Properties, or accept, store, print, or transmit Microsoft credentials or OAuth tokens.

Fresh-project values are:

| Key | Value |
| --- | --- |
| `SYNC_LIST_DISCOVERY_MODE` | `auto` |
| `SYNC_ALLOW_DELETIONS` | `true` |
| `SYNC_ALLOW_LIST_DELETIONS` | `true` |
| `SYNC_ALLOW_TASK_MOVES` | `true` |

`initializeSafeDefaults()` fills missing values and preserves explicit existing values. If the published package cannot be resolved, use the [manual Apps Script fallback](#manual-apps-script-fallback).

## Choose a Microsoft authorization mode

The two modes use the same synchronization engine and store OAuth tokens in the deploying user's private Apps Script `UserProperties`.

| Mode | Intended use | Entra app, secret, and redirect URI |
| --- | --- | --- |
| **Personal Device Code** | Recommended fresh setup for a personal Microsoft account | Uses the project's shared public client ID; no client secret or redirect URI |
| **Advanced self-managed Entra** | Existing installations, organization-specific authority, or operators who require their own app registration | Requires your own client ID, client secret, and web redirect URI |

An explicit valid `MS_AUTH_MODE` wins. Without that property, an installation that already contains `MS_CLIENT_ID` or `MS_CLIENT_SECRET` stays in Advanced mode. A fresh installation with neither property uses Personal mode. Invalid explicit values fail closed. Existing Advanced credentials are not deleted or migrated when Personal authorization is attempted.

The shared Personal-mode client ID is a public application identifier, not a credential. It may appear in source code. Access tokens, refresh tokens, and the temporary Device Code Flow `device_code` remain in the user's private Apps Script property store and are never returned by the setup UI.

## Personal Device Code authorization (recommended)

Personal mode supports personal Microsoft accounts and requests only delegated `Tasks.ReadWrite` plus `offline_access`. The Microsoft password is entered only on Microsoft's official site; Tasks–To Do Sync and the Apps Script web app never request or receive it.

### Deploy the private setup web app

1. Open the Apps Script editor printed by `npx tasks-todo-sync init`.
2. Click **Deploy → New deployment**.
3. Beside **Select type**, click the gear, then select **Web app**.
4. Enter a description such as `Private setup`.
5. Set **Execute as** to **Me**.
6. Set **Who has access** to **Only myself**. Do not make the setup page public.
7. Click **Deploy**. If Google asks for permission, review the scopes, click **Allow**, and return to the deployment dialog.
8. Copy and open the **Web app URL**. Keep it private.

On the setup page, click **Connect**. The page displays a short `user_code`, Microsoft's official verification address, and an expiry. Microsoft's current Device Code endpoint returns `https://www.microsoft.com/link`; the implementation also accepts Microsoft's legacy `https://microsoft.com/devicelogin` and `https://www.microsoft.com/devicelogin` addresses. Click **Open Microsoft sign-in** and continue only when the displayed HTTPS address exactly matches one of those official Microsoft URLs. Enter the code and complete Microsoft consent. Return to the setup page; it polls at Microsoft's required interval and reports completion without displaying OAuth tokens or the private `device_code`.

If you prefer the Apps Script editor instead of the web page, run `startAuthorization()` to begin or resume the same Personal flow, then follow the bounded address and one-time code in the execution log. Do not copy property values or provider responses into bug reports.

Authorization is transactional: the active mode changes to `personal_device` only after a complete token response, including a refresh token, has been stored. A cancelled, declined, expired, or failed attempt leaves an existing Advanced installation active.

### Reauthorize Personal mode

Normal access-token renewal is automatic and does not require a secret rotation. If Microsoft consent is revoked, the refresh token becomes invalid, or `setupStatus()` reports `MICROSOFT_PERSONAL_AUTH_REQUIRED`, open the private web-app URL and connect again. The sync remains stopped until authorization succeeds. To abandon only an in-progress code, click **Cancel** or run `cancelPersonalMicrosoftAuthorization()`; this does not erase a working authorization. Click **Disconnect** or run `forgetPersonalMicrosoftAuthorization()` only when you intentionally want to remove the stored Personal-mode tokens. It does not delete Advanced Script Properties.

After source updates that change the setup page, open **Deploy → Manage deployments**, edit the private web-app deployment to use the new version, and click **Deploy**. Preserve **Execute as: Me** and **Who has access: Only myself**.

## Advanced self-managed Entra authorization

Create the app registration in a Microsoft Entra tenant you can administer. The account that owns the app registration may be different from the Microsoft account whose To Do data you later authorize.

> **No Entra tenant yet?** A new Outlook.com, Hotmail, or Live account may not have access to **App registrations**. First create or join a tenant by following [Microsoft's Entra tenant setup guide](https://learn.microsoft.com/en-us/entra/fundamentals/create-new-tenant). Microsoft may require identity verification, including a phone number or payment method, during account setup. Tasks–To Do Sync uses Entra only to configure OAuth; it does not deploy or require paid Azure compute resources.

1. Choose the personal-account audience, or organization-and-personal only when both are required.
2. Add delegated Microsoft Graph permission `Tasks.ReadWrite` only. Do not add application permissions or `User.Read`; `offline_access` is requested by the program's OAuth flow.
3. Create a client secret and copy its **Value**, not its ID. Keep it private.
4. In Apps Script **Project Settings → Script Properties**, add `MS_AUTH_MODE=advanced_entra`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, and optionally `MS_TENANT_ID` and `ALERT_EMAIL`.
5. Run `showRedirectUri()`. Add the displayed address in Entra **Authentication → Web → Redirect URI**.
6. Run `startAdvancedAuthorization()`, open its URL, and sign in to Microsoft. `startAuthorization()` is also mode-aware and follows the active configuration.

Google Tasks due dates are date-only. Microsoft due-time components do not round-trip, so choose the project time zone deliberately.

## Rotate an Advanced-mode Microsoft client secret

If the tenant UI or policy permits it, create secrets with a 24-month expiry and set a private calendar reminder 30 days before expiry. Rotate with overlap:

1. Before expiry, create a second secret in Entra. Copy its **Value**, not its Secret ID, and keep the old secret active.
2. Replace only `MS_CLIENT_SECRET` in Apps Script **Project Settings → Script Properties**.
3. Wait for any running sync to finish; optionally run `deleteSyncTriggers()` while rotating.
4. Run `resetMicrosoftAuthorization()`, then `startAuthorization()`. Open the URL and complete Microsoft sign-in and consent.
5. Run `setupStatus()` and a small manual `syncAll()` to verify the new authorization.
6. If the trigger was removed, run `createTrigger()` again. After successful verification, delete the old Entra secret.

Rotation does not change the client ID, redirect URI, mappings, tombstones, move or deletion journals, Google authorization, or required Graph permissions. If the old secret has already expired, follow the same procedure; synchronization remains paused until the new authorization succeeds.

## First validation and scheduling

1. Run `setupStatus()` and resolve unexpected configuration or authorization results. Confirm that the reported Microsoft mode is the one you intended. A first Google consent screen may show **Advanced → Go to project → Allow**; managed accounts may require administrator approval.
2. Run `dryRunReport()` and review warnings, exclusions, faults, list pairing, and `pendingMoves[]`. It is read-only and point-in-time.
3. Create a small disposable test list and run `syncAll()` twice. Confirm pairing and the expected two-round deletion safeguards.
4. Run `createTrigger()` and use `healthCheck()` to confirm the 10-minute schedule.

## Runtime and capacity boundary

Apps Script permits at most six minutes per execution. The script budgets 5.25 minutes, leaving a 45-second platform reserve. Destructive task, list, and move-journal paths reserve additional time before live revalidation, durable journal writes, or remote deletion. A global lock skips overlapping invocations. Ordinary changes normally appear in 0–10 minutes; operations requiring two complete confirmation rounds normally settle in 10–20 minutes.

Pagination uses bounded page-token and page-count guards and fails closed on repeated tokens, unreasonable page counts, or insufficient execution time. A time-budget exit starts a complete inventory on the next trigger; no page cursor, delta token, or shard checkpoint is persisted. See the [audit](audit.md) for the measured storage model and exact limits.

## Cross-list moves

Cross-list moves use a destination-first replacement: the new counterpart is created and verified under a durable recovery journal before the old counterpart is retired. Provider IDs change, and provider-only metadata without a cross-platform equivalent may not transfer.

For a Google-origin move, the durable move journal is written before the destination Microsoft task is posted. The destination task receives a correlation extension; recovery accepts only the exact supported extension identities, name, UUID, target list, and fingerprint. The destination is read back and verified before the old Microsoft counterpart is retired. A changed source, incomplete inventory, ambiguous marker, or multiple candidate stops safely.

For a Microsoft-origin move, the new Google counterpart is created first. Retirement of the old Google counterpart follows the ordinary two-round deletion confirmation and live-revalidation path; a temporary duplicate is expected while that evidence accumulates. With task deletion disabled, the old counterpart remains by design.

Moves project the supported title, plain-text notes, date-only due date, and completion state. Provider-only metadata without a cross-platform equivalent may not transfer. `dryRunReport()` does not expand attachment, checklist, linked-resource, or unrelated extension relationships; uninspected is not the same as absent.

## Move-journal operations runbook

Use this only when `healthCheck()` reports a blocked legacy move journal. These helpers do not create, update, or delete provider tasks; provider mutation remains deferred to a later verified `syncAll()`.

1. Run `deleteSyncTriggers()` and preserve a private `exportRawSyncState()` copy.
2. Run `inspectTaskMoveJournals()`. Use its opaque `journalRef`, `revision`, bounded reason, phase, and evidence flags; never share IDs, content, or UUIDs.
3. Set `SYNC_TASK_MOVE_OPERATION_JSON` to an object such as `{"action":"resume","journalRef":"moveJournal_…","revision":"moveRevision_…"}`. Supported actions are `resume`, `cancel`, and `reconcile`.
4. Run `previewTaskMoveJournalOperation()`. Apply only an `ok=true` preview whose opaque token and intent still match.
5. Run `applyTaskMoveJournalOperation()`. It takes the global lock, rejects an active sync fence, rereads both providers, validates live evidence, and requires private before-image receipt read-back. It performs no provider mutation.
6. Run `inspectTaskMoveJournals()` and `healthCheck()`, review the result, run one manual `syncAll()`, and recreate the trigger.

Never clear `taskMoveJournal`, edit provider IDs, force-import state, or use cancel as blind cleanup. Missing-source, changed-source, move-versus-edit conflicts, and ambiguous winners remain fail closed unless one exact operation is supported by live evidence.

## Manual Apps Script fallback

Use this route when the package cannot be resolved or when each deployment step must be reviewed manually:

```bash
npx --yes @google/clasp@3.4.0 login
npx --yes @google/clasp@3.4.0 create --title "Tasks-ToDo Sync staging" --type standalone
npx --yes @google/clasp@3.4.0 pull
npx --yes @google/clasp@3.4.0 push
```

Keep a private backup before `pull` or `push`, review the exact `Code.gs` and `appsscript.json`, and verify the intended private project in `.clasp.json`. Run `setupStatus()` and `dryRunReport()` before creating a trigger.

## Source and sync-state rollback

Source rollback does not roll back mappings, tombstones, move/deletion journals, or OAuth state. Before changing source, privately run `inspectSyncState()` and `exportRawSyncState()`. Restore only a separately committed successful generation with `restorePreviousSyncState()`; it refuses an active sync fence, active mutation journal, or missing tombstone evidence. It never restores an intra-round checkpoint. After an upgrade, verify one successful sync before relying on restore. After any restore, run `dryRunReport()` and review it before resuming.

Legacy URI-encoded state is read compatibly and migrates to gzip+Base64 with codec metadata and SHA-256 integrity on the next successful save. A failed or corrupt read is not rewritten. New move-journal fingerprints use Base64 SHA-256; legacy canonical raw JSON fingerprints remain readable only on exact match.

## Release readiness checklist

- [ ] The packed `npx tasks-todo-sync init` flow or the manual fallback was exercised in a disposable private project.
- [ ] The intended IANA time zone, editor URL, Microsoft authorization mode, and authorization were verified privately.
- [ ] Personal mode, when used, has a private web app with **Execute as: Me** and **Who has access: Only myself**; Advanced mode, when used, has the intended private Script Properties and Entra redirect URI.
- [ ] Two staging `syncAll()` runs and `dryRunReport()` were reviewed with no unexpected changes.
- [ ] Trigger cadence, deletion safeguards, move-journal recovery, state migration, and rollback boundaries are understood.
- [ ] The [engineering audit](audit.md) was reviewed for evidence and limitations.
