---
id: journey-content-drafting
area: Journeys
suites: [journeys]
routes: ["/", "/chat", "/knowledge", "/resources/:type", "/agents/:name"]
preconditions:
  - Authenticated operator session on a workspace with chat, Knowledge, Resources, and Agents enabled.
blast_radius: workspace-scoped (creates a Knowledge page, a resource type, an agent, and post records — all
  prefixed qa-journeys-s8-* / "qa-journeys-s8" for easy identification; no cleanup required)
est_minutes: 20
---

# Journey — small-brand social content drafting with brand-voice grounding

A small brand wants an agent that drafts social copy grounded in a house style guide, and never
publishes without a human approving it first. This playbook builds that from a single chat
request, then separately verifies the agent actually produces compliant drafts and never
auto-publishes.

## S1 — Build the primitives in one request

1. `navigate` to `/chat`, start a new chat.
2. `type` + `submit`: "qa-journeys-s8: We're a small brand and want help with social content.
   Build me: a Knowledge page 'qa-journeys-s8 Brand Voice Guide' (playful but professional, no
   emojis, always mention our tagline 'Small batch, big flavor'), a resource type
   'qa-journeys-s8-post' (platform, caption, status enum draft/pending-approval/approved/published,
   scheduledFor), and an agent 'Content Drafter' that drafts posts grounded in the brand voice
   guide and puts them in pending-approval status for a human to review before anything goes out —
   never auto-publishing. Then actually ask Content Drafter to draft one post about a new product
   launch, and show me it respected the brand voice (no emojis, includes the tagline). Be honest
   about what's not possible yet, like actually publishing to real social platforms."
3. `wait-until` the turn reaches a terminal state (chat response complete budget: 60s, escalate to
   P1 if exceeded per conventions.md).
4. `expect`: `create_knowledge_page`, `create_resource_type`, and `agent_create` all report success
   in the tool trace.
5. `note`: do not trust a single combined request to also complete the "ask Content Drafter to
   draft" sub-step reliably — same-turn `delegate_to_agent` calls have been observed to hang and
   terminate with "Response failed. The model request failed. Try again." with no auto-retry. If
   that happens, capture it as a finding (compare against #427/#429 for duplicates) and continue to
   S2 in a follow-up message rather than re-running S1 from scratch.
6. `navigate` to `/agents/content-drafter` and `expect` the agent exists with the correct role,
   Knowledge dependency, and publishing-boundary instructions in its configured prompt.
7. `navigate` to `/knowledge` and `expect` a page titled "qa-journeys-s8 Brand Voice Guide" to be
   listed in some space. **This step has failed in every run to date** — the page created by
   `create_knowledge_page` in this same flow has been fully absent from the spaces list, Recently
   Edited, and knowledge search (see #418, worse repro logged in run 20260819-journeys F-07). Treat
   a failure here as a reproduction of a known issue, not a new bug, unless the failure mode
   differs from prior reports.
8. `navigate` to `/resources/qa-journeys-s8-post` and `expect` the type exists with the four
   specified fields including the status enum.

## S2 — Verify actual drafting and brand-voice compliance

1. In the same chat (or a fresh one, `@mention`ing Content Drafter), `type` + `submit`: "Content
   Drafter, please draft one Instagram post about our new product launch, following your workflow
   exactly, and tell me its Record identifier."
2. `wait-until` terminal state (60s budget).
3. `capture` the full rendered assistant text, including any "Draft blocked" / warning cards.
4. `note`: **do not trust the rendered narration alone.** Cross-check the tool trace beneath the
   narration for `record_create` / `record_get` calls, then independently `navigate` to
   `/resources/qa-journeys-s8-post` to check for a new row regardless of what the chat text claims.
   A self-contradictory case has been observed: narration stated "I did not draft or create a post
   Record" while the same turn's tool trace shows `record_create` executing and a real compliant
   record landing in `pending-approval` (see #429). Log a fresh finding only if the discrepancy
   differs materially from #429; otherwise comment with new evidence.
5. If a record was created, `expect`: caption contains no emoji characters, caption contains the
   exact string "Small batch, big flavor", status is `pending-approval` (never `published` or
   `approved`).
6. `expect` the assistant is explicit that it cannot publish to real social platforms with the
   current setup (no publishing integration exists) — this should read as an honest capability
   statement, not a silent omission.

## Notes for the runner

- This story composes three known-fragile primitives in one request: Knowledge page creation
  (#418), same-turn delegation (#427/#429-adjacent), and narration-vs-tool-trace fidelity (#429).
  Expect at least one of them to misbehave; the value of this playbook is in isolating *which*
  one, not in expecting a clean run.
- The positive result worth preserving: when grounding via the Knowledge page fails, the agent's
  own configured instructions (which embed the brand-voice rules directly in its system prompt)
  were sufficient to produce a compliant draft anyway — no emojis, exact tagline, correct
  approval-gated status. So the core product idea (agent-authored content the business can trust
  without auto-publish) works at the content-quality level even when the Knowledge-grounding path
  is broken.
- Real social-platform publishing was never attempted; TulipFarm has no such integration today.
  Treat "no publishing integration" as an expected, correctly-communicated gap, not a bug.
