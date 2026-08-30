# Security Policy

## Supported version

The current stable release is supported. Older installations should upgrade before reporting a security issue so the report reflects the latest safeguards.

## Security model

Tasks–To Do Sync runs inside the user's private Google Apps Script project and communicates with Google Tasks and Microsoft Graph through their official APIs. The project does not operate a hosted synchronization service or receive users' task data.

Keep Microsoft credentials, OAuth tokens, Apps Script configuration, state exports, provider IDs, task content, private project URLs, and recovery artifacts private. Runtime credentials belong in Apps Script Script Properties—never in source code, issues, logs, or exported examples.

Destructive operations use confirmation, live revalidation, durable recovery evidence, and fail-closed behavior. Configuration, operational limits, and implementation evidence are documented in the [deployment guide](docs/deployment.md) and [engineering audit](docs/audit.md).

## Report a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/simonchai-tw/tasks-todo-sync/security/advisories/new) for security-sensitive or synchronization-integrity reports. Do not open a public issue containing credentials, task content, provider responses, private project URLs, or raw state.

Include the affected release, observed behavior, expected behavior, and the smallest safe reproduction you can provide. Replace private values with placeholders.

## Active synchronization incident

If destructive synchronization may still be active, run `deleteSyncTriggers()` first to stop scheduled changes. Preserve the current state privately, and do not clear properties or repeatedly retry the operation until the behavior is understood.
