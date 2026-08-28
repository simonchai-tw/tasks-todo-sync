# Security Policy

## Supported version

| Version | Status |
| --- | --- |
| `0.1.3` | Current supported stable release |
| `0.1.2` | Previous stable release |
| `0.1.1` | Earlier stable release |
| Earlier releases | Upgrade before reporting a new issue |

## Security model

Tasks–To Do Sync is designed for one person connecting their own Google and Microsoft accounts through a private Google Apps Script project. Each user creates their own Microsoft Entra app registration and keeps the project, triggers, Script Properties, and synchronization state private.

Store the Microsoft client-secret **value** and all runtime configuration only in Apps Script Script Properties. Never publish credentials, OAuth tokens, `.clasp.json`, `.clasprc.json`, state exports, move-correlation values, before-image receipts, provider IDs, personal email addresses, private Apps Script URLs, or task content.

Fresh `v0.1.3` projects use these defaults:

```properties
SYNC_LIST_DISCOVERY_MODE=auto
SYNC_ALLOW_DELETIONS=true
SYNC_ALLOW_LIST_DELETIONS=true
SYNC_ALLOW_TASK_MOVES=true
```

Task and list deletion, plus cross-list moves, use confirmation rounds, live revalidation, durable journals, and tombstones where applicable. Fresh projects enable cross-list moves after maintainer testing verified both directions on a real account on 2026-08-28. Cross-list movement uses delete-and-recreate semantics, so provider-only metadata may not be preserved. The round fence keeps a prior successful deletion baseline when a run stops before final projection; restore uses only a separately committed successful generation and fails closed for legacy state without verifiable success.

## Report a vulnerability

Use GitHub's [private vulnerability reporting](https://github.com/simonchai-tw/tasks-todo-sync/security/advisories/new) for suspected credential exposure, unintended deletion, data leakage, authorization problems, or synchronization-integrity vulnerabilities. Do not open a public issue for security-sensitive reports.

Share only the minimum reproduction details and remove secrets, tokens, provider IDs, task content, account data, and private URLs. The public bug-report form enforces the same privacy reminder for non-security defects.

If a possible destructive-sync issue is active, run `deleteSyncTriggers()` first to stop scheduled changes. Preserve the evidence privately and avoid clearing state or retrying the operation until the behavior is understood.

## Runtime safeguards and limits

The 10-minute trigger does not change Apps Script's six-minute execution ceiling. The synchronizer uses a 5.25-minute run budget, an additional reserve before destructive mutations, a global lock, durable journals, bounded pagination guards, and full-inventory retries. An account whose complete inventory cannot finish within the budget needs persistent pagination/delta state or workload sharding; see the [engineering audit](docs/audit.md) for the current validation boundary. Per-round `durationMs`, `urlFetchCalls`, and `stateSaveCalls` metrics are bounded and do not contain task/list content; storage-headroom and metrics checks are recorded in the current audit.

Fatal alert emails are bounded and redacted: they retain the error class/code and correlation information needed for investigation, but omit task/list content, provider IDs, secrets, and full provider responses. Raw state exports, `SYNC_TASK_MOVE_OPERATION_JSON`, preview tokens, and before-image receipts remain sensitive private operational data even when reports use opaque references and bounded reason codes. Store Microsoft secrets only in Apps Script Script Properties; never put them in source, issues, logs, or exports. The recovery helpers protect concurrency and evidence; they do not replace Apps Script access control.
