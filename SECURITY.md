# Security Policy

## Supported version

| Version | Status |
| --- | --- |
| `0.1.0-rc.6` | Supported prerelease only; not stable or production-ready |
| Earlier candidates | Not supported for new use |

## Threat model and handling of secrets

This RC is for one person operating one private Apps Script project with their own Google and Microsoft accounts. Do not share that Apps Script project, its triggers, staging data, or its Script Properties with another operator.

Each user must create their own Microsoft Entra app registration. Store the **client-secret value** and all other runtime configuration only in Apps Script Script Properties. Never put a client secret, OAuth access/refresh token, `.clasp.json`, `.clasprc.json`, sync state export, move correlation UUID, operation before-image receipt, script/list/task ID, or personal email address in GitHub, a public issue, a pull request, a log attachment, or a screenshot.

Keep staging separate from any important data. Staging projects, mappings, state, and snapshots can reveal account structure even when they do not include a client secret.

## Reporting a vulnerability

Do not open a public issue for a suspected credential exposure, unintended task/list deletion, data leak, or sync-integrity vulnerability.

After the maintainer enables private vulnerability reporting for the repository, use the GitHub **Security** tab's **Report a vulnerability** flow. Until then, contact the maintainer privately and include only the minimum reproduction detail; do not send secrets, raw state, tokens, IDs, or production data. The release checklist must enable the private reporting setting before public use.

If a possible destructive-sync issue is found, first run `deleteSyncTriggers()` to stop scheduled changes. Preserve evidence privately, and do not clear state or retry destructive operations until the issue is understood.

## RC limitations

Public defaults keep `SYNC_ALLOW_DELETIONS`, `SYNC_ALLOW_LIST_DELETIONS`, and `SYNC_ALLOW_TASK_MOVES` set to `false`. Operators should enable them only after disposable-data testing. Google-origin cross-list movement is independently controlled by the move switch, persists a UUID journal before the destination POST, writes that UUID in the `com.tasksTodoSync.move` open type extension, replaces the Microsoft provider ID, and tombstones the retired counterpart ID. Recovery uses the documented unqualified-name filter only for unresolved target lists, then locally accepts only the exact `microsoft.graph.openTypeExtension.` and legacy `Microsoft.OutlookServices.OpenTypeExtension.` identities for that exact extension name, plus a valid matching UUID and content evidence. Bare names, suffix matches, and other prefixes are rejected. It fails closed if Microsoft changed, markers are missing/ambiguous, or inventory proof is incomplete.

Move-journal operation reports intentionally use deterministic opaque references and bounded reason codes. Treat `SYNC_TASK_MOVE_OPERATION_JSON`, raw exports, and the User Properties before-image receipt as private operational data. Preview tokens bind the exact action, journal reference/revision, candidate reference, confirmation, and live evidence; changing any effect-bearing field requires another preview. They are concurrency/evidence guards, not authentication secrets or a replacement for Apps Script access control. Apply requires the newly serialized receipt to read back exactly, so a stale non-empty receipt cannot authorize mutation. The operation apply helper changes local journal state only; a later `syncAll()` independently rereads both providers before any provider mutation.

The 10-minute trigger does not remove Apps Script's six-minute execution limit. The internal 5.25-minute budget leaves 45 seconds before the platform ceiling. Destructive task/list journal recovery and apply paths, plus move create/delete boundaries, stop with an additional 45-second internal reserve before live reads, durable journal writes, and remote mutation. Existing durable journals remain recoverable and volatile current-round confirmations are rolled back before catch-save. The next run performs a complete inventory because no page cursor or delta checkpoint is persisted. Accounts that cannot complete one inventory inside that budget are outside this RC's tested capacity boundary. See [the audit](docs/audit.md) for the remaining verification work.
