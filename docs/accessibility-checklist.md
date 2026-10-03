# Accessibility checklist (WCAG 2.2 AA)

Complete for every pull request that changes UI. The automated axe-core scan in CI is necessary but not sufficient.

- [ ] Everything works with the keyboard alone; focus order is logical and visible; no keyboard trap.
- [ ] Focus is not hidden by sticky headers or dialogs (2.4.11).
- [ ] Interactive targets are at least 24 by 24 CSS pixels (2.5.8).
- [ ] No action depends on dragging; a single-pointer alternative exists (2.5.7).
- [ ] Text contrast is at least 4.5:1 (3:1 for large text and UI components); information is never conveyed by color alone.
- [ ] Page works at 200% zoom and at 320 px width without horizontal scrolling.
- [ ] Headings, landmarks, labels and names are meaningful; form errors are announced and explained.
- [ ] Checked with a screen reader on at least one platform.
- [ ] Motion respects `prefers-reduced-motion`.
- [ ] Anything done by NFC tap has a non-NFC equivalent (search, QR scan or manual selection).
- [ ] Nothing the user has already entered must be re-entered in the same flow (3.3.7); no cognitive-test authentication (3.3.8).
