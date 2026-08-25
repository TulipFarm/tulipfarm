---
id: agents
area: Agents
suites: [full]
routes: ["/agents", "/agents/:name"]
preconditions: [at least one agent, or empty state]
blast_radius: creates at most one qa-<run-id>-* agent, and only through Chat — the web UI has no
  create/edit/delete route for Agents (`apps/web/app/lib/agents.ts` is a read-only client); any
  edit or delete of that agent this run creates also goes through Chat, never a direct soul write;
  read-only on every pre-existing agent
est_minutes: 8
smoke_scenarios: []
---

# Agents

Agents are `AGENT.md` files in the soul repo (`soul/agents/*`), loaded into the `SoulLoader` at
startup. `/agents` and `/agents/:name` are **read-only product surfaces** — per
`apps/api/src/soul/agents/routes.ts`, "Creation/editing of Soul agents happens through the
`agent_*` tools / forges, not here," and `apps/web/app/lib/agents.ts` is explicitly documented as a
"Read-only client for the agents API." There is no `/agents/new` route and no edit or delete
control anywhere in the web UI. The only product path that creates, updates, or deletes an Agent is
Chat, through the `agent-forge` skill the default assistant loads for this kind of request (which
calls `agent_create` / `agent_update` / `agent_delete`, all soul-backed tools defined in
`apps/api/src/soul/agents/tools.ts`). If a scenario needs an Agent to exist and Chat cannot produce
it, that is a product gap — report it, never create the `AGENT.md` file directly.

Every scenario stands alone — a failure in one does not block the next.

## S1 — Agent list and empty state

| # | Action | Expected |
| --- | --- | --- |
| 1 | `navigate /agents` | Renders within 5s |
| 2 | If no agents exist | `EmptyState` renders: section label "agents", heading "Agents", hint "No agents registered. Agents load from your soul repo (`soul/agents/*`) at startup." |
| 3 | If agents exist | A breadcrumb trail `agents` (nav labeled "Breadcrumb"), then a count line reading "1 agent" or "N agents" (exact singular/plural per `apps/web/app/routes/_app.agents._index.tsx:32`), then one row per agent |
| 4 | For each row | `expect` the row is a single link whose accessible name includes the agent's label (or name if no label) and, when present, its description; domain and autonomy render as trailing text/badge (autonomy uppercase, e.g. "supervised") |
| 5 | `click` a row | Navigates to `/agents/<name>` |
| 6 | `expect` no console error on either the empty or populated render | Clean |
| 7 | `capture` screenshot, console delta, failed requests | — |

`note`: when agents exist, this page renders **no `<h1>`** — only the breadcrumb nav and the count
line (`ResourcePanel` is a shared shell with no heading slot). The empty-state variant *does* render
an `<h1>` ("Agents"). This asymmetry is real (confirmed in source, not a rendering artifact) and
matches the same pattern on other `ResourcePanel`-shelled list routes (e.g. Resources) — it is not
agent-specific. Still assert "one `h1`, no skipped level" per convention; a missing `h1` on the
populated list is a **P2** a11y finding if reported, but don't file it a second time if
`a11y-console-hygiene.md` already caught it app-wide.

## S2 — Agent detail: identity, description, model, autonomy

Requires at least one existing agent (from S1, or `qa-<run-id>-*` created in S4).

| # | Action | Expected |
| --- | --- | --- |
| 1 | `navigate /agents/<name>` | Breadcrumb `agents / <name>`; renders within 5s |
| 2 | `expect` an `<h1>` with the agent's label (or name) beside its glyph | Present — this route, unlike the list, does render one |
| 3 | `click` `Chat with <label>` | Navigates to `/?agent=<name>` (button text is literally `Chat with ${label}`, from `_app.agents.$name.tsx:63`) |
| 4 | `expect` (if the agent has a description) it renders as body text below the button | Present |
| 5 | `expect` a definition list of set fields only — `label`, `domain`, `model`, `autonomy` — each row present only when the underlying frontmatter value is set (`MetaRow` returns nothing for `undefined`) | Matches the agent's actual frontmatter; no "domain: —" placeholder rows |
| 6 | `expect` the markdown body (the agent's system prompt) renders below, inside a bordered section | Present, no raw markdown syntax leaking through |
| 7 | `capture` screenshot, console delta, failed requests | — |

The `model` field shown here is the agent's configured **effort preset id** (e.g. `auto`,
`balanced`), not a provider model name — same "no `claude-*`/`gpt-*` string" rule as the composer's
effort picker in `chat.md` S5. `AgentFrontmatterSchema` only requires it be a single non-whitespace
token, so nothing stops an operator from setting a raw provider id, but any value the picker doesn't
recognize is simply not reflected as a preset (`chat-panel.tsx`'s `asPickerPreset` returns
`undefined` and the picker keeps its current value) — it is not itself a finding to see an
unrecognized string here.

The glyph (`AgentGlyph`) is `decorative` in **every** production usage (list, detail, chat header,
composer chip, mention menu, mention hover card — verified across all six call sites) and always
sits beside visible text carrying the same information. It never needs, and never exposes, its own
accessible name — don't flag it as an unlabeled icon.

## S3 — Governance card: expect it absent on any Chat-created agent

| # | Action | Expected |
| --- | --- | --- |
| 1 | On an agent detail page, check for a "Governance" section (`aria-labelledby="agent-governance-title"`) | Present only if the agent's frontmatter carries **both** `version` and `candidateVersion` — `apps/api/src/soul/agents/routes.ts` builds `governance` only when both are set |
| 2 | If present, `expect` rows for Roles, Skills, Tools, Model profile, Limits, Evaluation, and a status line, plus a button `Propose version <candidateVersion>` (disabled unless `publication.canPublish`) | Matches `AgentGovernanceCard` |
| 3 | If present, `note` the agent's `name` and do **not** click `Propose version` unless it is a `qa-<run-id>-*` agent this run controls — that action calls a real `POST /api/v1/agents/:name/changesets` write | Recorded, not exercised on someone else's agent |

**Ground truth, not a guess:** `agent_create`/`agent_update` (the only Agent-write path Chat has)
validate frontmatter against `AgentFrontmatterSchema`
(`packages/schema/src/agent.ts`), which is `additionalProperties: false` and allows only `label`,
`domain`, `description`, `model`, `autonomy`, `placeholder`, `suggestions`. `version`,
`candidateVersion`, `roles`, `skills`, `tools`, `modelProfile`, `limits`, `evaluationStatus`,
`evaluationSuite`, `publicationStatus`, `canPublish` — every field the Governance card reads — are
**not in that allow-list** and are rejected as `validation_error` if a caller tries to write them.
So a `qa-<run-id>-*` agent created in S4 below can never carry a Governance card; expect its
absence there, not a bug. If a **pre-existing** agent does show one, it was seeded by something
other than the product's own creation tool — plausible (a fixture, or the separate
`/api/v1/agents/:id/changesets` publication pipeline gated behind `agents:write`, whose own route
description says "The browser cannot publish or write Agent files directly"), but if the operator
expected `agent_create` to be able to reach this surface, **that mismatch is a P2 product-gap
finding worth filing once**: the only Agent-authoring tool in the product cannot populate the
fields its own detail page has a whole card for.

## S4 — Creating a qa-<run-id>-* agent through Chat

No UI create route exists (confirmed in S0 preamble) — this only works through Chat.

| # | Action | Expected |
| --- | --- | --- |
| 1 | `navigate /` (fresh chat) | Empty state renders |
| 2 | Send `qa-<run-id> create an agent named qa-<run-id>-tester in domain support, autonomy supervised, with a one-line description, whose job is to answer FAQ questions` | Turn starts |
| 3 | `wait-until` streaming stops (max 60s) | Transcript shows a `[tool: skill]` row (loading `agent-forge`) followed by a `[tool: agent_create]` row, both resolved (not stuck `running…`) |
| 4 | `expect` no error banner; response indicates the agent was created (assert on shape/intent, not wording — per the nondeterminism rule in `chat.md`) | Non-empty, coherent |
| 5 | `navigate /agents/qa-<run-id>-tester` | Loads; label/domain/autonomy/description reflect what was requested |
| 6 | `expect` no Governance card (per S3) | Absent |
| 7 | `capture` screenshot, console delta, failed requests | — |

**Validation path** (same conversation or a fresh one): send `qa-<run-id> create an agent named
QA Tester With Spaces` (an invalid kebab-case name — `agent_create`'s `NAME_RE` is
`^[a-z][a-z0-9-]*$`). `expect` the assistant does not falsely claim success; either it corrects the
name itself and creates `qa-<run-id>-...` (self-correcting on the AJV/regex error message) or it
reports the rejection. **A silent "created" claim with no matching agent reachable at `/agents`
afterward is P1** — that is exactly the "intent clearly unmet" case the Chat conventions call out.

This tool is documented as having **no approval gate** ("Soul writes are direct and ungated" —
`platform-agents.ts`). If the signed-in session has autonomy set to Approval mode (`chat.md` S6),
`note` whether an approval card appears for `agent_create` anyway — a mutating soul write that
bypasses the approval gate documented elsewhere in the product would be worth a P2 consistency
finding, not asserted as pass/fail by default since the "no approval gate" behavior may be
intentional for this specific tool.

## S5 — Invoking the created agent from Chat via @ mention

| # | Action | Expected |
| --- | --- | --- |
| 1 | `navigate /` (fresh chat) | Empty state |
| 2 | Type `@` | Agent menu opens; `qa-<run-id>-tester` appears (label + description, agent glyph) |
| 3 | Select it, then send `qa-<run-id> what can you help with?` | Per `mention-config.ts`: the `@agent` mention "routes the turn (first one wins, sets `agentId`)" |
| 4 | `wait-until` streaming stops (max 60s) | Non-empty response, no error |
| 5 | `expect` a header strip appears above the transcript reading "Agent · qa-<run-id>-tester" (or its label) once a message exists | Present — `chat-panel.tsx`'s `hasMessages && activeAgentName` header |
| 6 | `expect` the response reflects the mentioned agent's persona/domain in some form (support FAQ framing), not the generic default assistant's voice | Judged semantically, per the LLM-assertion rule — a completely generic answer with zero trace of routing is worth a `note`, not an automatic fail |
| 7 | Reload the resulting `/chat/:id` | `currentAgent` rehydrates from the persisted conversation; header strip still shows the agent |
| 8 | `capture` screenshot, console delta, failed requests | — |

Separately, from the agent's own detail page (`/agents/qa-<run-id>-tester`), `click`
`Chat with qa-<run-id>-tester` and `expect` the empty-state heading reads "Chat with
qa-<run-id>-tester" (or its label) with subtext "This Chat is using a user-created Agent." — this
is the second, equivalent routing path (`?agent=` query param) and should land in the same place as
the `@` mention.

## S6 — Authority: displayed tool/skill scope and the autonomy ceiling vs. actual enforcement

Two distinct mechanisms live in this area. Keep them separate — only one of them is a security
boundary.

**6a — Per-Skill tool-offer narrowing is a context-size optimization, not authorization.**
`packages/agent-runtime/src/loop/loop.ts:53-58` (commit `e64e178`) narrows which tools the loop
**offers** the model on an iteration where a Skill is active, to that Skill's declared `tools:`
scope, plus a fixed always-exposed set (`skill`, `complete_task`, `delegate_to_agent`,
`present`, `request_input`, `update_presentation`), plus every mutating Tool the Agent holds
(#419 — a Skill scope may hide a read and never a write). Seeing any of these alongside a narrowed
scope is correct, not a leak. The doc comment is explicit: **"context-size optimization
only, not a security boundary — `exposed` below still authorizes every `tools` entry regardless of
what a given iteration offers the model."** So:

| # | Action | Expected |
| --- | --- | --- |
| 1 | In a chat, type `/` and pick a Skill with a narrow, obviously bounded purpose, then send a prompt inside that purpose | Turn completes; `wait-until` streaming stops (max 60s) |
| 2 | Expand `[tool: <name>]` rows in the transcript (`parts.tsx`'s `ToolPart`, click to open, `aria-expanded`) | Tool names used are plausibly within the Skill's scope |
| 3 | In a later turn, ask for something clearly outside that Skill's purpose | If a tool call outside the Skill's obvious scope appears and executes, treat this as **P2 at most** (context bloat, or a UI that misrepresents what the agent will be offered) — narrowing failing on its own is never a P1, because it was never an authorization control |

**6b — The agent's displayed `autonomy` field is the real authority claim to check, and its
enforcement path does not trace where the UI implies it does.** `/agents/:name` shows `autonomy`
(`full` / `supervised` / `approval-required` / `manual`) as agent metadata, and
`packages/schema/src/definitions/agent.ts` documents the SPEC-level concept as an "autonomy
ceiling" bounding effective authority. But the actual chat-turn approval gate,
`needsApproval` (`apps/api/src/internal/tool-dispatch.ts:76-78`,
`autonomy === "approval-required" && definition.mutating`), reads `request.autonomy` — and that
field is populated **only** from the per-turn value the composer sends on `ChatBody`
(`apps/api/src/chat/turn-helpers.ts:14`, threaded through `apps/api/src/internal/turn-context.ts:92`).
No code path found that resolves the *routed Agent's own* `frontmatter.autonomy` into
`request.autonomy`. If that trace is accurate, an Agent's displayed `approval-required` ceiling is
never consulted by dispatch unless the operator *also* separately sets the composer's own autonomy
mode to Approval — the exact "UI displays an authority the intersection would deny" pattern.

| # | Action | Expected |
| --- | --- | --- |
| 1 | Ensure `qa-<run-id>-tester` (or a fresh `qa-<run-id>-*` agent) has `autonomy: approval-required` — update it via Chat if needed | `/agents/qa-<run-id>-tester` shows `autonomy: approval-required` |
| 2 | `navigate /`, leave the composer's own autonomy mode at its **default** (not the explicit Approval mode used in `chat.md` S6) | Composer shows its default autonomy mode |
| 3 | `@`-mention the agent and send a prompt requiring a mutating tool it's allowed to call, e.g. `qa-<run-id> create a resource type called qa-<run-id>-authority-probe` | Turn starts |
| 4 | `wait-until` streaming stops or an approval card appears (max 60s) | — |
| 5 | If **no approval card appears** and the mutating tool executes directly | Confirms the trace above: report as a **P1 finding** — the Agent detail page displays an authority ceiling that the actual dispatch path never consults, so a real user could reasonably rely on `approval-required` to constrain an agent when it does not |
| 6 | If an approval card **does** appear | Either the trace above is stale (re-verify against current `main` before filing anything) or some other layer enforces it — `note` where, and treat this scenario as passing (authority displayed matches authority enforced) |
| 7 | `note` the created `qa-<run-id>-authority-probe` resource type for the operator to clean up | Recorded |

## S7 — Delegation / child-run surface

Searched for a delegation or child-Run UI (`apps/web/app/components/runs/`, `/runs`, `/agents/*`)
against `@tulipfarm/agent-runtime`'s `src/delegation/` (helper Agents as child Runs). **None
exists in the web UI today** — no route, component, or copy referencing delegation or a child-Run
list was found anywhere under `apps/web/app`.

| # | Action | Expected |
| --- | --- | --- |
| 1 | On an agent detail page and in a completed chat transcript, look for any child-Run, delegation, or "handed off to" affordance | Not present |
| 2 | `note` this as expected-absent per the source search above; if a delegation UI has since shipped, treat its discovery as new surface to extend this scenario for, not a failure of this scenario | Recorded |

## S8 — Unknown agent name and loading states

| # | Action | Expected |
| --- | --- | --- |
| 1 | `navigate /agents/qa-<run-id>-does-not-exist` | `wait-until` settled (max 5s, navigation budget) |
| 2 | `expect` `NotFoundState` renders: "error: 404 not found", "No record matches that id (it may have been deleted)." — section label "agents" | Friendly 404, not a crash or blank page |
| 3 | On a slow network throttle (if available) or just by observation, `navigate /agents` and `/agents/<name>` | `expect` content paints within the 5s navigation budget; there is **no dedicated loading skeleton/spinner** for either route in source (no `useNavigation` indicator at the app shell, no per-route fallback) — a blank panel that resolves within budget is this app's accepted house style, not itself a finding |
| 4 | If either route's content visibly takes longer than 5s with nothing shown in the interim | **P2, missing loading state** — the severity table calls this out by name |
| 5 | `capture` console delta and failed requests | — |

## S9 — Both themes, 375px, keyboard access

| # | Action | Expected |
| --- | --- | --- |
| 1 | Toggle to the other theme (`Toggle dark mode`, in the signed-in app shell) on `/agents`, `/agents/<name>`, and the empty state | All text (breadcrumb, count line, row text, meta rows, markdown body, Governance card if present) legible in both themes; toggle back to the recorded baseline afterward |
| 2 | Resize to 375px width | List rows, the definition list, and the markdown body wrap without horizontal overflow; `Chat with <label>` remains reachable |
| 3 | Tab through `/agents` (populated) | Each row is one focus stop (whole-row link), visible focus ring, in list order |
| 4 | Tab through `/agents/<name>` | Order: breadcrumb links → `Chat with <label>` → (if present) Governance `Propose version` button → markdown body has no phantom stops |
| 5 | `expect` exactly one `h1` and no skipped heading level on the detail page and the empty-list page (see S1's `note` for the populated-list exception) | Per convention |
| 6 | `capture` screenshot for each theme/width combination | — |

## Notes for the runner

- **Every mutation in this playbook goes through Chat, never the API or the filesystem.** There is
  no create/edit/delete surface for Agents in the web UI — this is by design
  (`apps/web/app/lib/agents.ts` is documented read-only), not a gap this playbook needs to route
  around with `curl` or a soul-repo write. If Chat cannot reach a state this playbook needs, file it
  as a product gap.
- **S3 is the load-bearing finding in this file.** The Governance card's fields
  (`version`, `candidateVersion`, `roles`, `skills`, `tools`, `modelProfile`, `limits`,
  `evaluationStatus`, `publicationStatus`, `canPublish`) are read by
  `apps/api/src/soul/agents/routes.ts` but rejected by the write-time schema
  (`packages/schema/src/agent.ts`) that `agent_create`/`agent_update` enforce. Confirm this is
  still true against the running `main` before treating an absent Governance card as "working as
  intended" rather than re-verifying — schema and route can drift independently.
- **S6a (tool narrowing) is not an authorization check — do not file it as security.** Per-Skill
  tool-offer narrowing in `packages/agent-runtime/src/loop/loop.ts:53-58` is its own source comment's
  words a "context-size optimization only, not a security boundary." An offered-but-unrelated tool
  never dispatching is expected; one that dispatches and returns a result is at most P2 (context
  bloat / misleading UI), never P1 on this basis alone.
- **S6b (autonomy ceiling) is the real security assertion for this file — ground severity there.**
  The Agent's displayed `autonomy` is only meaningful if the runtime actually consults it.
  `apps/api/src/internal/tool-dispatch.ts`'s `needsApproval` reads `request.autonomy`, which
  traces only to the composer's own per-turn control (`apps/api/src/chat/turn-helpers.ts`,
  `apps/api/src/internal/turn-context.ts`) — no traced path resolves the routed Agent's own
  `frontmatter.autonomy` into that request. If confirmed live, an Agent shown as
  `approval-required` that a mutating call bypasses without an approval card is a **P1**: the UI
  displays an authority the actual dispatch path does not enforce. Re-verify against current `main`
  before filing — this is a source trace, not an observed run.
- If the signed-in session cannot produce any agents and Chat's `agent_create` path itself fails
  (e.g. no LLM provider configured), skip S2–S6 with a `note` and still run S1 (empty state), S7
  (delegation surface — has no precondition), S8 (404 + loading), and S9 against whatever list
  state is available.
- `qa-<run-id>-tester` (or whatever name S4 mints) is left in the soul repo for the operator to
  remove manually via Chat (`agent_delete`) — this playbook does not delete it automatically, per
  the "cleanup is not performed" rule in `conventions.md`.
