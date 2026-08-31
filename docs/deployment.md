# Deployment guide — 0.2.1

## Scope and release boundary

This guide is the operational source of truth for the personal Google Apps Script synchronizer. A private Apps Script trigger runs every 10 minutes; GitHub hosts the source and release history. Fresh projects enable automatic list discovery, task deletion, list deletion, and cross-list task moves. Existing explicit Script Properties are preserved. See the [changelog](../CHANGELOG.md) for history and the [engineering audit](audit.md) for evidence and limits.

Google and Microsoft authorization are separate sign-ins. The CLI deploys source only; Entra registration, client-secret creation, Script Properties, redirect URI setup, and Microsoft authorization remain manual and private.

## Productized `init` flow

Use Node.js 22 or later:

```bash
npx tasks-todo-sync init
```

The CLI uses `clasp` to create a private standalone Apps Script project, apply the computer's IANA time zone (or `--timezone <IANA>`), push the exact `Code.gs` and `appsscript.json` release sources, and print the editor URL and remaining steps. Open the URL and run `initializeSafeDefaults()` in the editor. The CLI does not open the editor, execute Apps Script functions, write Script Properties, or accept, store, print, or transmit Microsoft credentials or OAuth tokens.

Fresh-project values are:

| Key | Value |
| --- | --- |
| `SYNC_LIST_DISCOVERY_MODE` | `auto` |
| `SYNC_ALLOW_DELETIONS` | `true` |
| `SYNC_ALLOW_LIST_DELETIONS` | `true` |
| `SYNC_ALLOW_TASK_MOVES` | `true` |

`initializeSafeDefaults()` fills missing values and preserves explicit existing values. If the published package cannot be resolved, use the [manual Apps Script fallback](#manual-apps-script-fallback).

## Microsoft Entra and Script Properties

Register an application for the Microsoft account you will connect:

1. Choose the personal-account audience, or organization-and-personal only when both are required.
2. Add delegated Microsoft Graph permission `Tasks.ReadWrite` only. Do not add application permissions or `User.Read`; `offline_access` is requested by the program's OAuth flow.
3. Create a client secret and copy its **Value**, not its ID. Keep it private.
4. In Apps Script **Project Settings → Script Properties**, add `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, and optionally `MS_TENANT_ID` and `ALERT_EMAIL`.
5. Run `showRedirectUri()`. Add the displayed address in Entra **Authentication → Web → Redirect URI**.
6. Run `startAuthorization()`, open its URL, and sign in to Microsoft.

Google Tasks due dates are date-only. Microsoft due-time components do not round-trip, so choose the project time zone deliberately.

## Rotate a Microsoft client secret

If the tenant UI or policy permits it, create secrets with a 24-month expiry and set a private calendar reminder 30 days before expiry. Rotate with overlap:

1. Before expiry, create a second secret in Entra. Copy its **Value**, not its Secret ID, and keep the old secret active.
2. Replace only `MS_CLIENT_SECRET` in Apps Script **Project Settings → Script Properties**.
3. Wait for any running sync to finish; optionally run `deleteSyncTriggers()` while rotating.
4. Run `resetMicrosoftAuthorization()`, then `startAuthorization()`. Open the URL and complete Microsoft sign-in and consent.
5. Run `setupStatus()` and a small manual `syncAll()` to verify the new authorization.
6. If the trigger was removed, run `createTrigger()` again. After successful verification, delete the old Entra secret.

Rotation does not change the client ID, redirect URI, mappings, tombstones, move or deletion journals, Google authorization, or required Graph permissions. If the old secret has already expired, follow the same procedure; synchronization remains paused until the new authorization succeeds.

## First validation and scheduling

1. Run `setupStatus()` and resolve unexpected configuration or authorization results. A first Google consent screen may show **Advanced → Go project → Allow**; managed accounts may require administrator approval.
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
- [ ] The intended IANA time zone, editor URL, Script Properties, Entra redirect URI, and authorization were verified privately.
- [ ] Two staging `syncAll()` runs and `dryRunReport()` were reviewed with no unexpected changes.
- [ ] Trigger cadence, deletion safeguards, move-journal recovery, state migration, and rollback boundaries are understood.
- [ ] The [engineering audit](audit.md) was reviewed for evidence and limitations.
