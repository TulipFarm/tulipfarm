# Known issues — QA suppressions

Checked before any finding is reported. A match is downgraded to a `note` in the run report and
excluded from triage.

Only add entries here through the triage step, or deliberately. A suppression is a decision to stop
seeing a real problem — record why.

## Format

```markdown
### <short title>

- **Added**: YYYY-MM-DD
- **Matches**: how to recognize it (playbook/step, route, message text)
- **Reason**: why it is suppressed (wontfix, tracked elsewhere, expected in dev)
- **Tracking**: issue link, or `none`
- **Review by**: YYYY-MM-DD, or `n/a`
```

## Entries

### ColorZilla body attribute causes a Chrome-only hydration warning

- **Added**: 2026-08-09
- **Matches**: preflight console hydration mismatch where the only rendered diff is
  `cz-shortcut-listen="true"` on `<body>` and the console source is a Chrome extension hook
- **Reason**: a browser extension mutates `<body>` before React hydration; the attribute is absent
  from the app source and production HTML. Suppressing all body hydration warnings would hide real
  regressions, so only this exact signature is ignored.
- **Tracking**: none
- **Review by**: n/a

The first full run will produce volume, including P3 polish findings — that is the intended
behavior, not noise to pre-empt. Triage decides what lands here.

> Pre-existing dev console noise is **not** suppressed here. It is measured per run by preflight
> (`00-preflight.md` S4), reported once as a single baseline finding, and then excluded from
> per-step reporting automatically.
