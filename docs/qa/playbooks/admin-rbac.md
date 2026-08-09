---
id: admin-rbac
area: Admin & RBAC
suites: [full]
routes: ["/admin/users", "/admin/roles", "/admin/guardrails"]
preconditions: [admin session; skipped with a note otherwise]
blast_radius: creates at most one qa-<run-id>-* invited user (email only; account creation is
  never completed); disables that one invited row to revoke its link; never touches any other
  user, role, or guardrail. Role administration in this deployment is read-only end to end (no
  create/edit/delete surface exists in the UI, and its API write route is server-stubbed to
  always fail) and Guardrail administration's only mutation (the per-stage Enable/Disable toggle)
  is likewise server-stubbed to always fail before any write lands — see "Reality check" — so this
  playbook's actual ability to weaken anything is zero by construction, not by discipline alone.
est_minutes: 10
smoke_scenarios: []
---

# Admin & RBAC

Admin & RBAC covers user provisioning (`/admin/users`), the role catalog (`/admin/roles`), and
guardrail administration (`/admin/guardrails`) — the highest-blast-radius area in this playbook
set, because a mistake here can affect every other user's access. **Admin session only.** If the
signed-in session is not an admin, this whole playbook skips with a `note`; see S1.

Every scenario stands alone — a failure in one does not block the next.

## Reality check

Read before running anything below. Every route/endpoint pairing here was traced from the web
loader through `apps/web/app/lib/*` to the Fastify route in `apps/api/src` and confirmed
registered, per the verification requirement for this playbook. Several surfaces do materially
less than their names suggest.

- **`/admin/roles` has no create, edit, delete, assign, or unassign UI at all.**
  `apps/web/app/routes/_app.admin.roles.tsx` renders a bare read-only `<ul>` of
  `role.name` / `role.principalKinds` / `role.grants` — no form, no button, no mutation of any
  kind. This is not a missing-UI gap layered on a working API: the write endpoint
  `POST /api/v1/roles/changesets` (`apps/api/src/admin/routes.ts:825-879`) is wired to
  `proposeRoleChangeset()` in `apps/api/src/admin/runtime.ts:281-286`, which unconditionally
  throws `OperationalNotImplementedError("Role authoring is not available in this deployment:
  roles are built into this deployment and have no changeset writer.")` → HTTP `501`. There are
  also only ever **two roles, ever**: `admin` and `member`, hardcoded in
  `apps/api/src/identity/roles.ts` (`DEPLOYMENT_ROLES`) with a code comment stating plainly "there
  is no role editor and no roles table." **A `qa-<run-id>-*` role cannot be created through this
  product today** — treat "create a minimal role, assign/unassign permissions, delete it" as an
  unreachable objective and a product gap, not something to fake through another path.
- **`/admin/guardrails`'s only mutation (the per-item Enable/Disable button) is also
  server-stubbed to always fail**, and cannot ever change a guardrail's real state. The button
  posts to `POST /api/v1/guardrails/changesets`
  (`apps/api/src/admin/routes.ts:551-626`), wired to `proposeGuardrailChangeset()`
  (`apps/api/src/admin/runtime.ts:207-212`), which unconditionally throws
  `OperationalNotImplementedError("Guardrail authoring is not available in this deployment: Soul
  writes do not route through the changeset gateway yet.")` → `501`. This makes the toggle safe to
  exercise (nothing it does can ever weaken a guardrail — the write cannot land), but it means the
  UI presents a live-looking Enable/Disable control with no working effect behind it.
- **The guardrail item shape returned by the read API does not match what the UI expects, and
  this is independently confirmable, not just a type-level mismatch.**
  `getGuardrails()` (`apps/api/src/admin/runtime.ts:198-205`) flattens `soul/guardrails.yaml`'s
  three stage keys into `{ name, policy }` items — `name` is one of `"input"` / `"tool-call"` /
  `"output"`, `policy` is that stage's guard-config array (e.g.
  `[{ guard: "prompt_injection", sensitivity: "medium" }]`). Neither `id` nor `enabled` exists on
  the wire. But `apps/web/app/lib/admin.ts`'s `GuardrailItem` type declares `id`, `enabled`,
  `effect`, `scope`, and `_app.admin.guardrails.tsx` renders from them directly:
  `key={item.id}` (always `undefined` for every row — a real React duplicate-key condition),
  `item.effect ?? "configured"` / `item.scope ?? "all"` (always fall through to the generic text —
  the actual guard config, e.g. which tools are blocklisted or which patterns the content filter
  matches, is **never shown anywhere in this UI**), and the toggle label
  `item.enabled === false ? "Enable" : "Disable"` (always `undefined === false` → `false` → every
  row always reads **"Disable"**, never "Enable", regardless of real state). Worse:
  `proposeGuardrailToggle` (`apps/web/app/lib/admin.ts`) computes the target index with
  `model.items.findIndex((candidate) => candidate.id === item.id)` — since every `id` is
  `undefined`, this always resolves to index `0` ("input"), so clicking Disable on the
  *tool-call* or *output* row constructs a JSON-patch `path` of `/items/0/enabled`, targeting the
  wrong stage. This is independently observable by capturing the outgoing request body in S7, not
  just by reading source — the API's OpenAPI schema for this route declares
  `items: { additionalProperties: true }`, so nothing at the contract layer catches the drift.
  **Report as P2**: the wrong-index bug is real and reproducible from the network tab even though
  it is currently inert (the 501 fires before any index would matter).
- **Neither `/admin/roles` nor `/admin/guardrails` has a sidebar entry.** `SETTINGS_LINKS` in
  `apps/web/app/components/app-sidebar.tsx:77-87` lists only `/admin/users` ("Users"); the
  `isAdmin` filter (`LinkList`, line 300) gates that one link. Roles and Guardrails are reachable
  **only by typing the URL** — there is no discoverable path to either from anywhere in the
  product, for an admin or otherwise. Report as **P2** (navigation gap), independent of the
  read-only/stub findings above.
- **The top-bar breadcrumb does not distinguish the three `/admin/*` pages.**
  `PAGE_META` in `app-sidebar.tsx:434-449` matches any `/admin`-prefixed path to one entry,
  `{ label: "Admin", icon: Users }`. The breadcrumb therefore reads "Settings › Admin" on
  `/admin/users`, `/admin/roles`, and `/admin/guardrails` alike — only the in-page `<h1>`
  (Users / Roles / Guardrails) tells them apart. Report as **P3**.
- **`/admin/users` is the one fully real surface here.** `GET/POST /api/v1/users`,
  `POST /api/v1/users/:id/invite`, and `PATCH /api/v1/users/:id/status`
  (`apps/api/src/auth/routes/users.ts`) are all registered and implemented against real repos —
  confirmed by tracing `apps/web/app/lib/users.ts`'s `listUsers` / `createUser` /
  `reissueInvite` / `setUserStatus` to each route in turn. Its server-side protections
  (`requireAdmin`, self-status-change block, admin-status-change block) are real code, checked in
  S8.
- **Every `/admin/*` route has an `h1`.** Unlike sibling playbooks that found none, all three
  files render one: `Users` (`_app.admin.users.tsx`), `Roles` (`_app.admin.roles.tsx`),
  `Guardrails` (`_app.admin.guardrails.tsx`) — each `<h1 className="text-lg font-semibold">`.
  Confirmed by reading all three files directly; no finding here.
- **No `window.confirm` anywhere in this area.** Grepped `_app.admin.*.tsx`, `lib/users.ts`,
  `lib/admin.ts` — no destructive control uses the native dialog. The disable/enable toggle and
  the guardrail toggle are both plain async button handlers.

---

## ABSOLUTE PROHIBITIONS — read before running any scenario

- **NEVER delete a user. NEVER change any existing user's role. NEVER change the operator's own
  role.** These are not offered by the UI today (see Reality check), but if a future build adds
  them, this rule still applies without exception.
- **NEVER weaken a guardrail.** If a scenario needs a guardrail change to observe an effect: record
  the prior value first, make the change strictly **more** restrictive (never less), assert, and
  restore **immediately** in the same scenario. Per the Reality check, the write path currently
  always fails server-side before landing — but the discipline is followed exactly as if it could
  succeed, every time. **A failed restore is a P0 finding, reported to the operator at once** — if
  this deployment ever ships working guardrail writes and a restore fails, stop and escalate
  immediately rather than continuing the run.
- **NEVER grant elevated authority to anything**, including a `qa-<run-id>-*` agent or role.
- **Role CRUD is scoped to `qa-<run-id>-*` roles this run creates, with MINIMAL permissions** —
  moot today per the Reality check (no role can be created through the product), but binding if
  that ever changes.
- **Invites**: creating a `qa-<run-id>-*` invite is allowed. **NEVER complete account creation,
  never accept an invite** — conventions forbid creating accounts or entering passwords, full stop.
- **This playbook skips with a `note` if the session is not admin** — detected via the `Users`
  sidebar item's visibility (see S1). Skipping is the first step, always.
- **Never trigger a native browser `confirm()` dialog.** None exist in this area (see Reality
  check), so this is a non-issue in practice, but re-check if new destructive controls appear.
- **Never `curl` the API for feature verification.** UI only, per `AGENTS.md` and
  `docs/qa/conventions.md`.

---

## S1 — Admin-session detection and the skip path

The very first step of this playbook, every time.

| # | Action | Expected |
| --- | --- | --- |
| 1 | Inspect the sidebar's Settings section (already rendered from preflight S3, or `navigate /settings`) | The `Users` item (with a `Users` icon) is present under Settings **only** for an admin session — `apps/web/app/components/app-sidebar.tsx:300` filters it by `isAdmin` |
| 2 | If `Users` is **absent**: `note` "non-admin session — admin-rbac.md skipped" and stop here. Do not attempt to reach `/admin/users`, `/admin/roles`, or `/admin/guardrails` by URL | Skip recorded, not a finding |
| 3 | If `Users` is **present**: proceed to S2. Also `note` that `/admin/roles` and `/admin/guardrails` have no sidebar entry at all (Reality check) — they are reached only by direct `navigate` for the rest of this playbook | Recorded once |
| 4 | `capture` screenshot of the sidebar state | — |

## S2 — `/admin/users`: list, role display, PII exposure

| # | Action | Expected |
| --- | --- | --- |
| 1 | `navigate /admin/users` | Within 5s: `h1` "Users"; description text "New users get an invite link to share manually; they choose their own password when they open it. A new link is also how someone who forgot their password gets back in."; an `email` field and `Invite user` button; a list of existing users |
| 2 | `expect` each row shows the user's email, their role (`admin` or `member`, plain text — `apps/web/app/routes/_app.admin.users.tsx:207`), and a status label (`active` / `invite pending` / `disabled`) | Present |
| 3 | `expect` **no** row exposes a password hash, a full invite token, or any other row's pending invite link — the only token ever shown is the one this run's own invite issues once, in S3 | Clean — `PublicUserSchema` (`apps/api/src/auth/schemas.ts:9-18`) returns only `id`/`email`/`role`/`status`, confirming no server-side leak either |
| 4 | `expect` **the current admin's own row shows no Disable/Enable or invite-link button** — `apps/web/app/routes/_app.admin.users.tsx:209` hides row actions entirely when `user.role === "admin"` | Present (admins are never individually actionable from this list) |
| 5 | `note` every non-admin row's action buttons (`Disable`, `New invite link`, `Reset password link`) without clicking any of them — they belong to accounts this run did not create | Observed only |
| 6 | `capture` screenshot, console delta, failed requests | — |

## S3 — `/admin/users`: invite a `qa-<run-id>-*` user — validation, duplicate email, pending status

| # | Action | Expected |
| --- | --- | --- |
| 1 | Leave `email` blank | `expect` `Invite user` is disabled (`email.trim().length === 0` — `_app.admin.users.tsx:193`) |
| 2 | `type` `email` a syntactically invalid value (e.g. `not-an-email`), `click` `Invite user` | Button reads "Inviting…"; `wait-until` settled (max 10s) — the HTML5 `type="email"` input plus the server's `format: "email"` check reject it; `expect` an inline `error:` alert, no user created |
| 3 | `type` `email` `qa-<run-id>@example.invalid`, `click` `Invite user` | `wait-until` settled (max 10s) — succeeds: an `InvitePanel` appears reading "Invite link for **qa-<run-id>@example.invalid**. Share it manually — it won't be shown again, and it expires \<date>." with the URL in a `code` block, and `Copy` / `Dismiss` buttons |
| 4 | `expect` the URL contains `/accept-invite#token=` (fragment, not `?token=`) | A token in the query string would land in server logs — P1 if violated |
| 5 | `capture` the invite URL as evidence by reading the code block (do not rely on `Copy`/clipboard) | Recorded — needed for S4 |
| 6 | `expect` the new row appears in the list with status "invite pending" | Present |
| 7 | Repeat step 3 with the **same** `qa-<run-id>@example.invalid` address | `wait-until` settled (max 10s) — inline `error:` alert surfacing the server's `409` (`EmailAlreadyExistsError`, `apps/api/src/auth/routes/users.ts:81-83`); no duplicate row created |
| 8 | `capture` screenshot, console delta, failed requests | — |

## S4 — `/admin/users`: revoke the invite; empty and loading states

The product has no button labeled "Revoke" — disabling a `qa-<run-id>-*` invited row is the real
revoke mechanism: `previewInvite`/`acceptInvite` both refuse a token whose owning account is
`disabled` (`apps/api/src/auth/invites.ts:167-169, 184-187`), collapsing to the same "no longer
valid" message S5 (in `auth.md`) exercises for a dead token.

| # | Action | Expected |
| --- | --- | --- |
| 1 | On the `qa-<run-id>-*` row from S3, `click` `Disable` | Button disabled while busy (`rowBusy`); `wait-until` settled (max 10s) — row's status label updates to `disabled`, and its action buttons collapse to `Enable` only (no invite-link action offered — `STATUS_ACTIONS.disabled.inviteLabel` is `null`) |
| 2 | `note` (P3, copy/discoverability): the action that actually revokes an outstanding invite link is labeled `Disable`, not `Revoke` or `Revoke invite` — nothing on the page names what this button does to the pending link | Recorded |
| 3 | In a **fresh incognito context**, `navigate` to the invite URL captured in S3 | `expect` the same collapsed "no longer valid" dead-link state `auth.md` S5 documents — confirms the disable actually revoked redemption, not just the row's displayed label |
| 4 | Back in the admin session, `note` whether the list ever renders an explicit empty-state message if it had zero users — in practice unreachable (the signed-in admin's own row always exists), and the markup has no dedicated empty-state branch to begin with (`apps/web/app/routes/_app.admin.users.tsx:203-233` renders a bare `<ul>` either way) | Recorded as a coverage gap, not a finding |
| 5 | `note` the loading state observed between navigating to `/admin/users` and the list painting — SPA `clientLoader` suspends the route, so there may be no interstitial at all | Recorded |
| 6 | `capture` screenshot, console delta, failed requests | — |

## S5 — `/admin/roles`: role list and the read-only reality

Per the Reality check, there is no create/edit/delete/assign UI to exercise. This scenario
verifies the read side and checks the displayed grants against `packages/authz`'s
authority-intersection semantics rather than inventing mutation steps that don't exist.

| # | Action | Expected |
| --- | --- | --- |
| 1 | `navigate /admin/roles` | Within 5s: `h1` "Roles"; text "Revision `<hash>`."; a list of **exactly two** rows |
| 2 | `expect` one row named `Administrator` (`principalKinds`: `user`) and one named `Member` (`principalKinds`: `user`) — `apps/api/src/identity/roles.ts` `ROLE_NAMES` | Present |
| 3 | `expect` the `Administrator` row's grants read `allow any action on any resource` (from `ANY_ACTION_ANY_RESOURCE`) | Present |
| 4 | `expect` the `Member` row's grants list `allow any action on any resource` **followed by** one `deny * on <resourceType>` entry per surface in `ADMIN_ONLY_SURFACES` (`secret`, `api_token`, `identity`, `observability`, `llm_config`, `knowledge_source`, `kv_system`, `setup`, `operations` — nine deny entries) | Present, nine `deny` entries |
| 5 | This is the "permission matrix" and "effective-permissions display" this playbook can actually check: `packages/authz/src/effective.ts`'s `evaluateGrants` says a **deny anywhere in a layer wins over an allow in the same layer** — which is exactly what the rendered `Member` row shows (the broad allow, narrowed by explicit denies). `expect` no grant on either row implies a permission that this intersection rule would actually contradict — e.g. no row should show an `allow` for a resource type it also lists a `deny` for without the deny visibly present too | If a role ever showed an `allow` where the intersection rule would deny, that is **P1** — a UI showing more access than the server would actually grant is a trust-breaking display bug, not cosmetic |
| 6 | `note`: this "matrix" is one static, hardcoded description of two built-in roles, not a live query against a specific principal's multi-layer authority (user + agent + run-context layers per `AuthorityLayer` in `effective.ts`) — the page has no per-user "what can this person actually do" view, and no `conditions` are ever populated (`RolesModel.items[].conditions`, `apps/web/app/lib/admin.ts`, is fetched but never rendered by `_app.admin.roles.tsx`) | Recorded, P3 |
| 7 | Confirm no create/edit/delete/assign control exists anywhere on the page | Confirmed absent — matches Reality check, not re-filed as a new finding |
| 8 | `capture` screenshot, console delta, failed requests | — |

## S6 — `/admin/guardrails`: guardrail list and config display

| # | Action | Expected |
| --- | --- | --- |
| 1 | `navigate /admin/guardrails` | Within 5s: `h1` "Guardrails"; text "Revision `<hash>`. Changes are Soul changesets and may require Approval."; a list of rows, one per configured stage (`input`, `tool-call`, `output` — or whatever `soul/guardrails.yaml` currently defines) |
| 2 | `expect` each row shows a name and the fallback text `configured · all` (`item.effect ?? "configured"` · `item.scope ?? "all"`) | Present — per the Reality check, this is **always** the fallback text; the API never returns `effect`/`scope`, so no row can ever show anything else |
| 3 | `expect` **no row shows the actual guard configuration** — no sensitivity level, no blocklisted tool names, no content-filter patterns | Confirmed absent. `note` (P2): an admin cannot audit what a guardrail is actually configured to do from this page — only that a stage named `input`/`tool-call`/`output` exists |
| 4 | Open the browser's network inspector (or equivalent) and inspect the raw `GET /api/v1/guardrails` response body | `expect` each item's real shape is `{ name, policy }` (e.g. `{"name":"input","policy":[{"guard":"prompt_injection","sensitivity":"medium"}]}`) — confirms the Reality check's read of `apps/api/src/admin/runtime.ts:198-205` against the live response, not just source |
| 5 | `expect` every row's toggle button reads **"Disable"**, never "Enable", regardless of which stage it is | Confirms `item.enabled === false` always evaluates `false` (`undefined !== false`) — the display bug is live-observable, not just theoretical |
| 6 | `note`: no "policy evidence" (an `AuthzDecision`'s `reason`/`deniedLayer`, per `packages/authz/src/effective.ts`) is surfaced anywhere on this page or `/admin/roles` — this UI shows configuration, never a decision trace | Recorded, informational |
| 7 | `capture` screenshot, console delta, failed requests | — |

## S7 — `/admin/guardrails`: the record → tighten → assert → restore cycle

**Read the Reality check before running this.** The write endpoint always returns `501` before any
change lands, so nothing here can actually weaken (or strengthen) a guardrail — but the full
discipline is followed exactly as written, both because that is the rule and because it is the
only way to prove the endpoint really is inert rather than silently succeeding.

| # | Action | Expected |
| --- | --- | --- |
| 1 | Record the current button label (always "Disable", per S6.5) and the current `revision` hash for one row — call it the target | Baseline recorded |
| 2 | `click` `Disable` on the target row | Button disabled while busy |
| 3 | While the request is in flight, capture the outgoing `POST /api/v1/guardrails/changesets` request body | `expect` the body's `changes[0].path` is `/items/<index>/enabled` — if the target row was **not** the first ("input") row, `expect` the index is nonetheless `0` (the `findIndex`-on-`undefined`-`id` bug from the Reality check). Record whichever you observe as **P2** if it targets the wrong index |
| 4 | `wait-until` settled (max 10s, form-submit budget) | `expect` the request fails with **`501`**, body `{"error":{"code":"not_implemented","message":"Guardrail authoring is not available in this deployment: Soul writes do not route through the changeset gateway yet.", ...}}` |
| 5 | `expect` the UI surfaces this failure to the operator somehow (an alert, inline text, anything) | **It does not.** `_app.admin.guardrails.tsx`'s `onClick` handler has a `try { … } finally { setBusy(undefined) }` with **no `catch`** — the rejected promise is unhandled. The button simply re-enables with no error shown. **Report as P1**: a mutation that fails produces zero operator-visible feedback, and the failure surfaces only as an unhandled-rejection console error (itself a new console error → P1 by the console-baseline convention, unless already known) |
| 6 | `expect` the row's displayed state (label, revision) is unchanged after the failed attempt | Unchanged — confirms nothing landed |
| 7 | **Restore step**: there is nothing to restore — the attempted change never took effect (step 4 confirms the `501` fired before any write). Record this explicitly rather than silently skipping the restore step | `note`: "restore not required — write never landed (501)" |
| 8 | If a future run of this playbook ever observes a `202` here instead of `501` (i.e., guardrail authoring has shipped): **stop, do not proceed with more changes**, revert immediately using the same UI, verify the revision matches the S7.1 baseline, and treat any failed revert as **P0**, reported to the operator at once | Contingency noted for the runner |
| 9 | `capture` screenshot, console delta (expect the new unhandled-rejection error), and the failed request | — |

## S8 — Negative RBAC assertion: server-side enforcement, not just UI hiding

The highest-value check in this playbook, and the one most constrained by having only one
signed-in session available.

| # | Action | Expected |
| --- | --- | --- |
| 1 | On `/admin/users`, attempt to change the signed-in admin's own status — there is no button to click (S2.4 confirmed the admin's own row has none), so this specifically checks the **server's** guard rather than the UI's: `apps/api/src/auth/routes/users.ts:203-206` rejects `id === req.user?._id` with `400 "cannot change your own status"` even if a request reached it | Cannot be exercised through the UI at all (no control exists) — recorded as a code-reviewed guarantee, not independently UI-verified this run |
| 2 | Attempt to disable a **different** existing `admin`-role user (if any exists besides the signed-in one) by inspecting whether the UI offers the control | `expect` **no** action buttons render on any `role === "admin"` row (S2.4) — `_app.admin.users.tsx:209` hides them structurally, not just visually (no `disabled` attribute to bypass, the buttons are absent from the DOM) |
| 3 | `note`: `apps/api/src/auth/routes/users.ts:212-214` independently rejects a status change targeting `target.role === "admin"` with `400 "cannot change the admin's status"` — server-enforced regardless of what the UI shows, but this run cannot fire that request through the product surface (no control exists to trigger it), so it is **not verified live this run** | Known gap, not a failure |
| 4 | **The core negative-RBAC question — does the server actually gate `/admin/users`, `/admin/roles`, `/admin/guardrails` on `admin`, not merely hide their links — cannot be answered through the UI with a single admin session.** All three routes require a second, non-admin, signed-in session to drive an actual denied request through the product surface (per `docs/qa/conventions.md`, `curl` is never a substitute). **State this explicitly as a known coverage gap; do not invent a workaround.** | **Known coverage gap — recorded, not silently skipped** |
| 5 | Record what the code guarantees instead, as a code-reviewed (not QA-verified) fact: `requireAdmin` (`apps/api/src/auth/routes/users.ts:14-16`) returns `403` for any `req.user?.role !== "admin"` on all four `/api/v1/users*` routes; `authorize()` (`apps/api/src/admin/runtime.ts:152-160`) returns `null` — which `requireGrant` turns into `403` — for any `principal.role !== "admin"` on `/api/v1/roles`, `/api/v1/guardrails`, and every other `admin/routes.ts` endpoint. Both checks are on the request's server-resolved principal, not a client-supplied header, and are structurally identical to (independent of) whichever link the sidebar happens to show | Recorded as the code-reviewed guarantee this run relies on |
| 6 | If a second, disposable non-admin account is ever available for a human dry-run: extend this scenario to `navigate` all three routes as that user and confirm `403` (not a redirect, not a silent empty page) is what actually comes back, and that `/admin/roles`/`/admin/guardrails` — which have **no `ErrorBoundary` export** (checked: neither file nor `apps/web/app/routes/_app.tsx` nor `root.tsx` defines one) — do not leak a raw error/stack trace when their `clientLoader` throws on that `403`. `/admin/users` **does** have an `ErrorBoundary` (`_app.admin.users.tsx:27-38`) that renders a clean "error: `<message>`" — the other two have no equivalent fallback, so a `403` there is expected to fall through to Remix's default (unstyled) error screen. **A raw stack trace or internal error detail on that fallback is P1**; a plain, non-leaking "something went wrong" is acceptable even without a custom boundary | Gap for the human dry-run; recorded verbatim |
| 7 | `capture` whatever evidence is available from this session's own attempts (S8.1–S8.3) | — |

## S9 — Unknown route / unknown id → actual behavior

None of `/admin/users`, `/admin/roles`, or `/admin/guardrails` take an `:id`/`:name` path segment,
so there is no per-item unknown-id case to test — this scenario covers the one shape that does
apply: a nonexistent `qa-<run-id>-*` id passed to `POST /api/v1/users/:id/invite`, which the UI
can only reach indirectly (there is no "invite by id" text field — the request always targets a
row already rendered from the list). Recorded as a code-level guarantee, not independently
reachable through the UI.

| # | Action | Expected |
| --- | --- | --- |
| 1 | `note`: `apps/api/src/auth/routes/users.ts:139-141` returns `404 "user not found"` for a nonexistent id on the reissue-invite route; this cannot be triggered from the UI because every reissue button is bound to a real row's id at render time | Code-reviewed guarantee, not UI-verified |
| 2 | `navigate` a syntactically plausible but nonexistent nested path under this area, e.g. `/admin/users/qa-<run-id>-does-not-exist` (no such route is defined — none of the three files in this area accept a param) | `expect` Remix's standard no-route-matched handling (its default splat/404, or a redirect if `_app.tsx` defines a catch-all) — **not** a React error overlay or blank white page |
| 3 | `expect` no leaked stack trace or internal error detail on whatever renders | A leaked internal detail here is **P1** |
| 4 | `capture` console delta and failed requests | — |

## S10 — Loading states, both themes, 375px

| # | Action | Expected |
| --- | --- | --- |
| 1 | Observe the moment before content paints on `/admin/users`, `/admin/roles`, and `/admin/guardrails` | `note` whatever appears (blank panel vs. spinner) — SPA `clientLoader` suspends the route, consistent with every other playbook's finding in this codebase; either is acceptable as long as nothing sits in a permanent loading state |
| 2 | On `/admin/users`, `click` `Invite user` with a valid new address and observe the button mid-request | `expect` "Inviting…" text, button disabled for the duration (max 10s) |
| 3 | Record the current theme, `click` `Toggle dark mode` (via `/settings/security` or wherever the toggle lives in this session) | Theme flips |
| 4 | Revisit all three `/admin/*` pages in the flipped theme | `expect` all text legible — labels, the `Revision <hash>` byline, alert text, the fallback `configured · all` text, disabled-button states |
| 5 | `click` `Toggle dark mode` again | Restored to the recorded baseline — a persisted preference on the operator's real session, must not be left flipped |
| 6 | Resize to 375px width | `expect` the invite form (`email` input + `Invite user` button) wraps rather than overflows; the Users/Roles/Guardrails list rows wrap their `flex-wrap` content rather than clipping; no page-level horizontal scroll on any of the three pages |
| 7 | `capture` screenshot, console delta, failed requests, at each theme and at 375px | — |

## S11 — Keyboard access

| # | Action | Expected |
| --- | --- | --- |
| 1 | On `/admin/users`, Tab from the top of the page content | Order: `email` field → `Invite user` → (if an `InvitePanel` is showing) `Copy` → `Dismiss` → each row's `New invite link`/`Reset password link` → `Disable`/`Enable`, each with a visible focus ring |
| 2 | On `/admin/roles`, Tab through the page | `expect` reaches nothing interactive beyond ambient navigation — there is no "permission matrix" widget to operate (per Reality check, the page is a static list), so there is no keyboard-operability gap to find here specifically. `note` this explicitly rather than assuming a matrix exists to test | Recorded — this playbook's version of the "matrix with no keyboard path is P2" check does not apply, because no interactive matrix exists at all; that absence is itself covered as a P2 finding already, under S5 |
| 3 | On `/admin/guardrails`, Tab through the page | Order: each row's toggle button in list order, each focus-visible |
| 4 | `expect` exactly one `h1` on each of the three pages, no skipped heading level | `Users`, `Roles`, `Guardrails` — confirmed present on all three (Reality check) |
| 5 | `capture` screenshot, console delta | — |

## Notes for the runner

- **Absolute prohibitions, restated**: never delete a user; never change any existing user's role;
  never change the operator's own role; never weaken a guardrail (record → tighten → assert →
  restore, immediately, every time — a failed restore is P0); never grant elevated authority to
  anything, including a `qa-<run-id>-*` role or agent; role/permission CRUD is scoped to
  `qa-<run-id>-*` artifacts with minimal permissions (currently unreachable — see below); invite
  creation is allowed, account creation and invite acceptance are never completed; never trigger a
  native `confirm()` (none exist here); never `curl` the API for verification.
- **Known coverage gap**: the negative RBAC assertion (S8) cannot fire an actual denied request
  through the product surface with only one admin session available. This playbook verifies the
  UI hides the right controls and records the server-side code guarantees
  (`requireAdmin`/`authorize()` role checks) as code-reviewed, not QA-verified, facts. A real
  live-fire test needs a second, disposable, non-admin signed-in session — flagged for a human
  dry-run in S8.6, same pattern `auth.md` uses for its own unverifiable guard.
- **Role administration has no create/edit/delete/assign surface, in the UI or the API.** Only two
  roles (`admin`, `member`) exist, hardcoded in `apps/api/src/identity/roles.ts`, and
  `POST /api/v1/roles/changesets` always `501`s. Do not treat this playbook's inability to create
  a `qa-<run-id>-*` role as a test-authoring gap — it is a product gap, reported once in the
  Reality check rather than re-discovered scenario by scenario.
- **Guardrail administration's only mutation always fails server-side (`501`) before any write
  lands**, which is what makes S7 safe to run at all — but the UI gives the operator zero feedback
  when it fails (no `catch`, no alert), which is a real P1 independent of the underlying
  not-yet-implemented capability.
- **`/admin/roles` and `/admin/guardrails` have no sidebar link** — only `/admin/users` does. Both
  are reachable by direct URL only, for admin and non-admin sessions alike (subject to the
  server's own `403`).
