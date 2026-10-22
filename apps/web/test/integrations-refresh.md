# Integration QA findings

Inspected October 2, 2026, from base `0258b29a950fdf08cd1d501131605bd5c7198518`.
The checks use Chromium and the local web application with intercepted API responses.
They do not qualify live Google behavior or server authorization.

## Status failures

Issue #275 reproduces when the personal GitHub account read returns 503 while
Google reads succeed. The old catalog drops the provider error and shows one
generic banner. Google tiles correctly remain connected.

[`status.ts`](../src/features/integrations/status.ts) now retains a safe read-error
description. [`integrations.tsx`](../src/pages/integrations.tsx) names the apps that
share the failed provider read and offers **Check app status again**. A slow retry
disables that button. A failed retry restores it. Successful checks remove the error.
The production provider that caused the original report remains unknown.

## Review refresh investigation

Issue #276 did not reproduce in the tested transitions. The review, selected tab,
checked authorization, and expanded exact payload survived provider focus refresh,
failure and recovery, slow workspace invalidation, a browser tab return, and
advancing the browser clock by 61 seconds. An explicit Google status failure
retained the review and blocked approval. Recovery restored the control.

An explicit Google status read returning 401 deliberately removed the review.
After recovery, the user had to open the proposal and confirm again.
[`useGoogleRead`](../src/features/google/read.tsx) discards data on access loss.
This behavior must not be bypassed to preserve a review.

No lifecycle code changed for #276. The issue remains open pending a reproducible
trigger. The fixture cannot rule out production session or workspace transitions.

## Approval automation

Issue #277 is a selector error, not trusted-event protection in the approval control.
`document.querySelector('[role=dialog] [role=checkbox]')` selects the hidden
**Disconnect my Google account and stop its heartbeat access** checkbox.
[`GoogleIntegrations`](../src/features/google/integrations.tsx) keeps Manage mounted
while Approvals is visible. A DOM query includes that hidden content.

The named approval checkbox supports a DOM `element.click()`, pointer input, and
the Space key. [`GoogleProposalReview`](../src/features/google/proposals.tsx)
uses `checked={confirmed}` and `onCheckedChange={setConfirmed}`. It does not inspect
`isTrusted`. No checkbox or authorization implementation changed.

Use an accessible name and the visible review in browser automation:

```js
const review = page.getByRole('region', {
  name: 'Exact Google action review',
  exact: true,
});
await review
  .getByRole('checkbox', {
    name: 'I reviewed Details and authorize this exact change',
    exact: true,
  })
  .check();
```

Checking the control does not submit approval. The fixture verifies that the
separate approval button sends only the reviewed digest and `decision: 'approve'`.
It never clicks Execute. Server checks remain unchanged.

## Reproduce the checks

Run from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm exec turbo run build --filter='@tulipfarm/web^...'
node --test apps/web/test/integrations-refresh.browser.mjs
pnpm check
```

The [browser test](integrations-refresh.browser.mjs) writes ignored screenshots to
`reports/integrations-refresh/`. It covers desktop light mode, narrow dark mode,
slow and failed reads, retry recovery, empty proposals, exact approval input,
and access-loss concealment. Existing low-contrast text in the dark review is
visible in the screenshot and is outside this status-error patch.
