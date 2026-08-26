# Security Policy

## Supported version

| Version | Status |
| --- | --- |
| `0.1.0` | Current supported stable release |
| Earlier releases | Upgrade before reporting a new issue |

## Security model

Tasks–To Do Sync is designed for one person connecting their own Google and Microsoft accounts through a private Google Apps Script project. Each user creates their own Microsoft Entra app registration and keeps the project, triggers, Script Properties, and synchronization state private.

Store the Microsoft client-secret **value** and all runtime configuration only in Apps Script Script Properties. Never publish credentials, OAuth tokens, `.clasp.json`, `.clasprc.json`, state exports, move-correlation values, before-image receipts, provider IDs, personal email addresses, private Apps Script URLs, or task content.

Fresh `v0.1.0` projects use these defaults:

```properties
SYNC_LIST_DISCOVERY_MODE=auto
SYNC_ALLOW_DELETIONS=true
SYNC_ALLOW_LIST_DELETIONS=true
SYNC_ALLOW_TASK_MOVES=false
```

Task and list deletion have been verified in both directions and use confirmation rounds, live revalidation, durable journals, and tombstones. Cross-list moves remain independently opt-in while real-account validation continues.

## Report a vulnerability

Use GitHub's [private vulnerability reporting](https://github.com/simonchai-tw/tasks-todo-sync/security/advisories/new) for suspected credential exposure, unintended deletion, data leakage, authorization problems, or synchronization-integrity vulnerabilities. Do not open a public issue for security-sensitive reports.

Share only the minimum reproduction details and remove secrets, tokens, provider IDs, task content, account data, and private URLs. The public bug-report form enforces the same privacy reminder for non-security defects.

If a possible destructive-sync issue is active, run `deleteSyncTriggers()` first to stop scheduled changes. Preserve the evidence privately and avoid clearing state or retrying the operation until the behavior is understood.

## Runtime safeguards and limits

The 10-minute trigger does not change Apps Script's six-minute execution ceiling. The synchronizer uses a 5.25-minute run budget, an additional reserve before destructive mutations, a global lock, durable journals, and full-inventory retries. An account whose complete inventory cannot finish within the budget needs persistent pagination/delta state or workload sharding; see the [engineering audit](docs/audit.md) for the current validation boundary.

Move-journal reports use opaque references and bounded reason codes, but raw state, `SYNC_TASK_MOVE_OPERATION_JSON`, preview tokens, and before-image receipts are still private operational data. The recovery helpers protect concurrency and evidence; they do not replace Apps Script access control.
