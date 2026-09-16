## Description

Briefly describe the change and why it was made.

Fixes #(issue)

## Type of Change

- [ ] Bug fix (non-breaking change which fixes an issue)
- [ ] New feature (non-breaking change which adds functionality)
- [ ] Refactor / Optimization
- [ ] Documentation update
- [ ] Security fix

## Architecture & Safety Checklist

- [ ] Apps Script runtime remains within the 17 canonical `.gs` files (no unauthorized file additions/removals).
- [ ] No dynamic `innerHTML =` or `outerHTML =` used in `Setup.html` or UI files.
- [ ] No credentials, access tokens, refresh tokens, device codes, or personal account identifiers included.
- [ ] Added or updated automated tests in `tests/` covering the change.
- [ ] All 416 tests pass (`npm test`).
- [ ] Static validation and package dry-run pass (`npm run check`).
