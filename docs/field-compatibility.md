# Field compatibility

This is the canonical field-compatibility source for Tasks–To Do Sync. It records what the synchronizer projects between Google Tasks and Microsoft To Do, what is provider-specific or not yet verified, and what remains planned research. A field being visible in one provider's UI does not by itself establish an API projection; likewise, an unverified field is not a claim that an API cannot support it.

## Verified supported

These fields and operations are covered by the current implementation and automated validation. Real-account validation should still be run for a release or deployment claim.

| Field or operation | Projection | Boundary |
| --- | --- | --- |
| Title | Google ↔ Microsoft | Plain task title |
| Notes | Google ↔ Microsoft | Plain-text projection; simple Microsoft rich text is converted to text |
| Due date | Google ↔ Microsoft | Date only; time of day does not round-trip |
| Completion status | Google ↔ Microsoft | Incomplete ↔ complete, including reopen |
| Personal lists | Google ↔ Microsoft | Eligible paired lists; list names are projected |
| Create, edit, and delete | Google ↔ Microsoft | Deletion is guarded by confirmation and recovery records |
| Move between lists | Google ↔ Microsoft | Destination-first replacement; counterpart provider IDs can change |

## Provider-specific or unverified

The following may exist in a provider UI or payload but are not part of the verified cross-provider projection. They must not be treated as supported-field failures, and this list does not assert that either provider's API makes them impossible:

- Microsoft reminders and reminder times;
- recurrence;
- importance, categories, and other Microsoft-only metadata;
- attachments and attachment details;
- checklist items;
- linked resources and unrelated extension relationships;
- formatting beyond the plain-text notes projection.

When these fields are encountered, the engine's preview and diagnostics may identify metadata loss or uninspected relationships. They are not silently promoted to a compatibility guarantee.

## Planned research

- Complete bidirectional real-account field matrix, including provider UI/API behavior and conversion rules.
- Rehearse reminders, recurrence, importance, categories, attachments, checklists, linked resources, and extension fields without treating UI presence as API proof.
- Validate concurrent edits and provider-specific formatting across supported account types.

## Supported environments

Initial installation and source updates require a Windows, macOS, or Linux desktop/laptop with Node.js 22+, a terminal, and a modern browser. Chromebook Linux is best effort. npm installation is not supported on phones; the Microsoft connection wizard remains mobile-responsive for reauthorization.
