# Human interaction UI evidence

Inspected and run on 29 September 2026. This change owns web UI and browser
verification. One shared test fixture now creates uniquely named teams to respect
the shipped team-name constraint. No backend runtime or migration changes were made.
Backend contracts come from earlier merged changes.

## User flow

`conversation-api.ts` parses ordered request, response, approval, and
approval-resolution references. `interaction-card.tsx` reads authoritative state
through the request or approval HTTP endpoint. It does not infer a decision from
ordinary messages or immutable history. Response references show a saved-response
notice; the original request card hydrates the answer. Loading older messages
recovers an original request outside the current history page.

Information requests accept text, one choice, or multiple choices. Approvals reuse
the shipped `ChatConfirmation` control and display the exact proposal, digest,
revision, and allowlisted destructive effect. Unknown effect shapes cannot be
approved. An approved card explicitly does not claim that execution completed.
Expiry and cancellation grant no approval.

The existing session/workspace key in `pages/workspace.tsx`, chat key, and request
cleanup scope drafts and requests to their current owner. No browser storage holds
answers or command credentials. A lost acknowledgement retains the exact command,
response identity, revision, and input in memory for retry. A reload instead reads
the durable result. Conflicts require a fresh read and explicit input review.

Pending cards check every two seconds for at most thirty automatic checks, then
offer **Check request status**. Errors stop automatic checks. Settled cards stop
polling and refresh history. Focus refresh rechecks current access; concealed
denials clear the card. Session expiry clears the private-chat view.

Tool publication in the inspected backend is a text part containing only one of
five fixed status labels. The UI renders that part as text. It does not request
internal histories, raw tool input, or results. No speculative tool-reference
endpoint was added.

The shipped attachment chips, carousel, and composer modules are unchanged.
PR #104 landed during this task. The rebase preserves its upload, download,
staged-chip, and message-attachment paths alongside the new interaction cards.

## Executed checks

Run from the repository root after `pnpm install --frozen-lockfile`:

```sh
pnpm check
pnpm --filter @tulipfarm/web test:interactions
pnpm --filter @tulipfarm/web test:conversations
```

The normal-stream integration check passed all 49 tasks in 6 minutes 54 seconds,
including 68 deployment regressions. The focused web suite passed 41 tests.
The existing conversation browser suite passed without changes to its assertions.

`interactions.browser.mjs` passed controlled HTTP cases for slow loading, repeated
read failure, retained input after refresh failure, text and both choice modes,
ordinary-send isolation, exact answer and approval replay after lost responses,
cancelled and expired requests, approved and rejected decisions, stale revision
review, reload, stopped settled polling, concealed access loss, and workspace and
session navigation. It also checked narrow-screen overflow, dark theme, reduced
motion, and keyboard approval activation. An 80-character unbroken chat title
reproduced overflow inside the mobile chat-history region. A bounded grid column
on its semantic list item fixed it. The regression checks the region itself,
the chat heading, the long approval heading, and the document at 390 pixels.
These are mocked-contract checks. Lost-response fixtures snapshot read results
and block new reads before committing so polling cannot race the retry assertion.

Screenshots were inspected from the local temporary artifact directory as
`approval-mobile-dark.png` and `approval-desktop-light.png`. Set
`CONVERSATION_SCREENSHOT_DIR` to an existing directory to regenerate them.

## Real backend run

The earlier opt-in backend proof at `a471d733ebcaf83632b439ca05f62ffd9ea75453`
is superseded. Main revision `24c6fec2889062300515cf17954f23befe62afec` was merged
into this branch without rewriting history, producing merge `8a0ee63dbdcdb88efeec69983d60d380d6f7b258`.

`interactions-live.browser.mjs` passed against this merged tree without
`CONVERSATION_BACKEND_ROOT`. Its unextended `approvalFixture()` provisions through
the normal `workspaceResourceMigrations(await agentCommonMigrations())` loader.
The runner compares every installed receipt name and checksum with that loader,
now asserts 22 receipts, and verifies the final names are shipped 0024 requests,
0025 approvals, and unshipped 0026 model allowance. The settings merge of `170daac`
into `6b05a8e` reran this proof successfully on 29 September 2026. It adds no custom
migration or opt-in stream. The settings integration evidence
records the combined checks.

The run used actual Chromium, Better Auth sessions, listening HTTP routes, and
restricted workspace PostgreSQL logins. It proved:

- Ordinary compose did not answer the pending request.
- Targeted text and multiple-choice answers survived reload.
- Lost acknowledgements replayed the exact response path and command body.
- One answer row existed after retry.
- Approve and reject produced the expected protected resolution.
- Approval left the resource migration waiting until separate execution applied it.
- Another workspace admin could not read the private chat.
- Revoked schema authority concealed the approval and recorded no winner.
- Information cancellation through the card and expiry through authorized polling
  produced terminal cards without an answer, including after reload.
- Approval cancellation through authenticated HTTP in the browser session replayed
  exactly. The UI observed the settled cancelled card through polling.
- Approval expiry used the production discovery and protected resolver callbacks.
  Polling displayed the settled expired card. Neither terminal path created a confirmation.
- Every information and approval outcome committed exactly one generation-one
  outbox row and queued turn. The actual executor completed each resumed turn with
  its expected literal reply. The ordinary message queued behind the answered
  request then completed separately.

`conversations-live.browser.mjs` also passed on the normal 21-receipt tree. It
exercised attachment quota recovery, same-identity upload and send retry, signed
private object I/O, download recovery, reload, archive retention, abandoned cleanup,
and admin and membership-incarnation denial. Its object server is local test I/O.

The shared approval fixture's fixed team name failed on the second proposal under
the normal stream's uniqueness constraint. Only its synthetic team name changed.
The seven approval and normal-upgrade integration tests passed after that correction.

The runner accepts `CONVERSATION_BACKEND_ROOT` so the parent can repeat the same
browser proof against its integrated tree without changing backend source:

```sh
TEST_ADMIN_DATABASE_URL="$LOCAL_TEST_ADMIN_DATABASE_URL" \
pnpm --filter @tulipfarm/web test:interactions:live
```

Build the selected backend's package dependencies first. The database variable
must target disposable loopback PostgreSQL as described in `docs/development.md`.
The fixture creates and removes its own database. Set `CONVERSATION_BACKEND_ROOT`
only to select another integrated tree. Old opt-in backends fail the receipt checks.
Optional `INTERACTION_LIVE_PORT`
and `INTERACTION_LIVE_API_PORT` avoid port collisions.

Workspace admission and Soul publication use fixture metadata. This run does not
prove Temporal dispatch, production deployment, or the full application bootstrap.
Approval expiry invokes the same callbacks directly rather than waiting for the
API sweep timer. The deterministic responder does not fabricate requests.
The parent owns the exact-head independent review and merge.

## Design decisions

An aggregate history hydration design would couple every old card's read failure
to the whole conversation and repeat reads during history pagination. Per-card
hydration keeps failures local and uses the existing bounded read/write hooks.
The request's discriminated type determines its form. The existing confirmation
control owns approval presentation. No new shared component module was needed.

Nested agent tools were unavailable in this session. Code and comment review were
performed locally; no independent-review claim is made. Parent review remains a
separate gate.
