# Security Policy

## Supported version

| Version | Status |
| --- | --- |
| `0.1.0-rc.3` | Supported prerelease only; not stable or production-ready |
| Earlier candidates | Not supported for new use |

## Threat model and handling of secrets

This RC is for one person operating one private Apps Script project with their own Google and Microsoft accounts. Do not share that Apps Script project, its triggers, staging data, or its Script Properties with another operator.

Each user must create their own Microsoft Entra app registration. Store the **client-secret value** and all other runtime configuration only in Apps Script Script Properties. Never put a client secret, OAuth access/refresh token, `.clasp.json`, `.clasprc.json`, sync state export, script/list/task ID, or personal email address in GitHub, a public issue, a pull request, a log attachment, or a screenshot.

Keep staging separate from any important data. Staging projects, mappings, state, and snapshots can reveal account structure even when they do not include a client secret.

## Reporting a vulnerability

Do not open a public issue for a suspected credential exposure, unintended task/list deletion, data leak, or sync-integrity vulnerability.

After the maintainer enables private vulnerability reporting for the repository, use the GitHub **Security** tab's **Report a vulnerability** flow. Until then, contact the maintainer privately and include only the minimum reproduction detail; do not send secrets, raw state, tokens, IDs, or production data. The release checklist must enable the private reporting setting before public use.

If a possible destructive-sync issue is found, first run `deleteSyncTriggers()` to stop scheduled changes. Preserve evidence privately, and do not clear state or retry destructive operations until the issue is understood.

## RC limitations

Public defaults keep `SYNC_ALLOW_DELETIONS`, `SYNC_ALLOW_LIST_DELETIONS`, and `SYNC_ALLOW_TASK_MOVES` set to `false`. Operators should enable them only after disposable-data testing. Cross-list movement requires both task deletion and task moves, recreates the destination task with a new provider ID, and tombstones the retired counterpart ID. See [the audit](docs/audit.md) for the remaining verification work.
