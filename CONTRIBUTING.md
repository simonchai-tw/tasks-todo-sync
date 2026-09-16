# Contributing to Tasks–To Do Sync

Thank you for your interest in contributing to Tasks–To Do Sync! This project is an open-source, private, self-hosted synchronization bridge between Google Tasks and Microsoft To Do running on Google Apps Script.

## Principles & Safety Invariants

Tasks–To Do Sync is stateful infrastructure. Because tasks represent real personal and work commitments, all contributions must uphold strict correctness and data-safety guarantees:

1. **The 17 Canonical `.gs` Files**:
   The Apps Script runtime consists of exactly 17 root-level `.gs` files listed in `lib/gas-files.mjs`. Do not introduce new `.gs` files or remove existing ones without prior architectural review.
2. **Deterministic Architecture & Load Order**:
   Apps Script evaluates top-level scripts in an environment where declaration order matters. Every function or class must pass canonical, reverse, and shuffled load-order gates.
3. **Core Scheduler Invariants**:
   - **R-Completeness**: Snapshot creation must be complete; partial reads fail closed without state mutations.
   - **Two-Round Deletion with Absence Probe**: Deletions require two distinct rounds with live absence probes to prevent false deletions from search-index artifacts.
   - **Starvation-Free Rotating Observation**: Resource observation advances through a deterministic cursor budget.
4. **Zero Dynamic HTML in Web Apps**:
   `Setup.html` and any Web App interfaces strictly prohibit dynamic `innerHTML =` or `outerHTML =` string interpolation. All DOM updates must use safe APIs (`textContent`, `classList`, `setAttribute`).
5. **Zero Token/Secret Leakage**:
   Never hardcode credentials, access tokens, refresh tokens, device codes, or personal account identifiers in code, documentation, or commit logs.

## Development Workflow

### Prerequisites

- **Node.js**: Version 22 or later.
- **npm**: Standard npm client.

### Setup

Clone the repository and install dependencies:

```bash
git clone https://github.com/simonchai-tw/tasks-todo-sync.git
cd tasks-todo-sync
npm install
```

### Running Checks & Tests

Before submitting any code changes, ensure all static validations and automated tests pass:

```bash
# Run static architecture and package dry-run checks
npm run check

# Run full hermetic unit test suite (416 tests)
npm test

# (Optional) Run 600-pair deterministic stress simulation
npm run stress:600
```

All 416 automated tests and package checks must pass with exit code `0`.

## Submitting Pull Requests

1. **Fork & Branch**: Create a feature branch off `main` (e.g. `feat/your-feature` or `fix/issue-description`).
2. **Keep PRs Focused**: Address a single problem or feature per PR. Avoid bundling unrelated formatting or refactoring changes.
3. **Add Tests**: If modifying synchronization logic, field merge, or setup workflows, add corresponding unit tests under `tests/`.
4. **Check Validations**: Run `npm run check && npm test` locally.
5. **Use the PR Template**: Fill out the pull request template completely, explaining the motivation, changes made, and verification steps.

## Code of Conduct & Communication

Be kind, respectful, and constructive. If you have questions or want to discuss a feature before building it, feel free to [open an issue](https://github.com/simonchai-tw/tasks-todo-sync/issues).
