# v0.3.0 engineering audit

Audit scope: 0.3.0 — 2026-09-06

The Personal Microsoft Device Code authorization extension described below is included in this release. Its automated and real-account evidence is recorded here.

Supported environment: initial installation and source updates require a Windows, macOS, or Linux desktop/laptop with Node.js 22+, a terminal, and a modern browser. Chromebook Linux is best effort. npm installation is not supported on phones; the Microsoft connection wizard remains mobile-responsive for reauthorization. The [field compatibility matrix](field-compatibility.md) is the canonical source for field boundaries.

## Release decision

`v0.3.0` is a stable personal, single-operator synchronization release. It includes compressed and integrity-checked state, backward-compatible migration, guarded deletion, recovery journals, tombstones, bounded diagnostics, destination-first cross-list moves, and the private Personal Microsoft setup page. Fresh projects enable automatic list discovery, task deletion, list deletion, and task moves; existing explicit Script Properties are preserved.

The core implementation is covered by 265 automated tests, CI, and CodeQL. Recorded bidirectional real-account checks cover task deletion, list deletion, and cross-list moves in the maintainer's private deployment. Local deterministic validation also exercises 600 tracked task pairs across synchronization, deletion, movement, recovery, pagination, and long-content scenarios. The deterministic 600-pair validation is provider-free; the separate bounded real-account observation below does not establish a universal provider or Apps Script runtime guarantee.

## Scope verification

- CLI time-zone handling parses and updates manifest JSON, so non-`Asia/Taipei` IANA zones do not depend on formatting.
- An incomplete run discards only current-round proof and retains the previous successful task/list-deletion baseline.
- Restore reads a separately committed successful generation, never an intra-round checkpoint. An upgraded deployment needs one verified successful sync first; legacy state without verifiable evidence fails closed.
- Metadata-only Google edits leave an existing Microsoft rich-text body unchanged; a changed notes projection updates the body.
- Authorization refresh/retry and fatal alerts are bounded. Fatal alerts are redacted. Persisted health errors contain status and bounded internal/request codes rather than raw provider responses.
- New state generations use gzip+Base64, codec metadata, UTF-8 decoded-size checks, and SHA-256 integrity. At most three generations are transiently retained during promotion.
- New move journals use compact Base64 SHA-256 fingerprints. Legacy canonical raw JSON fingerprints remain readable only on exact match.

## Microsoft authorization boundary

The authorization layer supports two additive modes. Fresh installations without legacy Microsoft client properties resolve to Personal Device Code mode. Existing installations containing `MS_CLIENT_ID` or `MS_CLIENT_SECRET` resolve to Advanced self-managed Entra mode unless an explicit valid `MS_AUTH_MODE` says otherwise. Invalid explicit modes fail closed. There is no forced migration, and a failed Personal authorization attempt does not erase or replace existing Advanced credentials.

Personal mode uses a shared Microsoft public-client application ID restricted to personal Microsoft accounts. A public client ID identifies the application and is not a secret. Personal mode requires no client secret and no redirect URI. It requests delegated `Tasks.ReadWrite` and `offline_access`; provider tokens and the temporary Device Code Flow session are stored in the deploying user's Apps Script `UserProperties`.

The private setup web app is designed to execute as the deploying user and be accessible only to that user. Its public projection may contain the short `user_code`, allowlisted official Microsoft sign-in address, expiry, and bounded status only. Real-account authorization completed through Microsoft's `https://www.microsoft.com/link` endpoint; the allowlist also accepts Microsoft's legacy `https://microsoft.com/devicelogin` and `https://www.microsoft.com/devicelogin` addresses. The UI does not return or log the OAuth `device_code`, access token, refresh token, raw provider response, or Microsoft password. The password is entered only on one of those official Microsoft pages.

Device polling must honor Microsoft's returned interval; `authorization_pending` is normal, and `slow_down` increases the interval by five seconds for the rest of that session. Personal mode becomes active only after access and refresh tokens are durably stored. Refresh-token rotation replaces the old token when Microsoft returns a new one; a successful response without a new refresh token preserves the existing refresh token. Reauthorization-required failures clear Personal tokens, stop synchronization, and produce bounded instructions rather than raw OAuth content.

Real-account Device Code Flow and private setup-web-app validation completed in the maintainer's disposable deployment. Deliberate provider-consent revocation is not part of the release acceptance scope; ordinary authorization, refresh-token rotation, reconnection, and disconnection paths are covered.

## Cross-list move boundary

Cross-list moves use a destination-first replacement: the new counterpart is created and verified under a durable recovery journal before the old counterpart is retired. Provider IDs change, and provider-only metadata without a cross-platform equivalent may not transfer.

Google-origin moves create the destination counterpart, read it back, verify the durable correlation marker and live source evidence, and only then retire the old Microsoft counterpart. Microsoft-origin moves create the new Google counterpart first; the old Google counterpart is retired through the ordinary two-round deletion confirmation and live-revalidation path. With task deletion disabled, that old counterpart remains. These are different provider paths, not one atomic cross-cloud transaction.

Automated coverage includes exact marker identity, journal recovery, source revalidation, conflict handling, duplicate prevention, and field conversion. `dryRunReport()` does not expand attachment, checklist, linked-resource, or unrelated extension relationships; those fields are uninspected rather than asserted absent.

## Scheduling and diagnostics boundary

The supported trigger cadence is 10 minutes. Apps Script permits at most six minutes per execution; the script budget is 5.25 minutes. Destructive paths reserve additional time before live reads, journal writes, or remote mutation. A time-budget exit starts a complete inventory on the next invocation: no page cursor, Graph delta token, or shard checkpoint is persisted. Page-token and page-count guards fail closed on repeated tokens, unreasonable counts, or insufficient execution time.

Per-round `durationMs`, `urlFetchCalls`, and `stateSaveCalls` are bounded, content-free values recorded only in the execution log. `sync_summary` is written only to the execution log; a 360 KiB threshold sends the storage-pressure email. `healthCheck()` does not display byte counts or these metrics.

## Storage capacity boundary

There is no fixed task-count limit. For routine unattended use, approximately 300 tracked task pairs is the conservative recommended operating envelope. Six hundred pairs is an observed stress boundary, not a support promise; accounts above the recommended envelope should be judged from their own completed-run duration and storage-pressure evidence. Provider-free Node/zlib modeling covers the capacity corners below. A separate real-account Apps Script observation seeded 600 tasks: the initial create round saved safely at the internal time budget after 286,307 ms and 551 URL fetches, the next round completed the remaining creates in 53,659 ms and 78 fetches, and two subsequent steady rounds completed in 28,768 ms and 19,199 ms with 18 fetches each. This demonstrates safe multi-round convergence in that deployment, not a universal provider-runtime guarantee.

| Scenario | Peak bytes |
| --- | ---: |
| Dense | 181,797 |
| Sparse | 196,672 |
| Steady-state / long Unicode | 183,669 |
| Deletions plus tombstones | 384,334 |

Six hundred simultaneous blocked move journals projected 475,030 bytes: 14,230 bytes above the 450 KiB preflight envelope, so the write fails closed before provider mutation. A separate 1,200-pair move-journal saturation probe reached 1,214,804 bytes; that is a storage cliff, not a support claim.

The measured model and implementation boundaries include an 8 KiB per-property value limit, a 450 KiB aggregate User Properties preflight envelope, a 360 KiB storage-pressure notification threshold, 7,000-character chunks, up to 100 chunks per generation, a 2 MiB uncompressed state limit, three retained generations at peak, 30-day tombstone retention, and the 5.25-minute execution budget. These limits fail closed and alert; they do not promise a fixed task-count envelope.

Normal fresh state does not store task titles, notes, or bodies in the mapping store. Long notes affect provider payload size and runtime, not the mapping store itself. Legacy journals and raw state exports can still contain sensitive material and must remain private.

## Evidence reviewed

- 265 automated tests, CI, CodeQL, static checks, package smoke validation, and the deterministic 600-pair VM/capacity run were recorded for the release worktree. CodeQL uses GitHub Default setup, so no repository-owned CodeQL workflow file is expected.
- Bidirectional real-account validation covered Personal Device Code authorization, supported task fields, task deletion, list deletion, cross-list movement, state rollback, and the bounded 600-task observation. The published observations omit private mappings, provider IDs, task contents, project identifiers, credentials, and Apps Script version numbers.
- Release publication and deployment execution are separate from source inspection; this audit does not infer evidence that was not observed.

## Validation boundary

Automated coverage includes 401 refresh/retry behavior, state-restore safeguards, field conversion, interrupted operations, and move-journal recovery. Real-account testing supplements those checks without attempting to recreate every provider-account or platform-failure permutation. Provider APIs still do not provide one atomic cross-cloud move; current protection is durable journaling, fresh rereads, fail-closed conflict handling, and recoverable residue.
