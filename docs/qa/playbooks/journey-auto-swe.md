---
id: journey-auto-swe
area: Journeys
suites: [journeys]
routes: ["/", "/agents/:name", "/runs"]
preconditions: signed-in session; real GitHub OAuth is never completed — this journey stops at the
  point GitHub access would be required
blast_radius: creates a qa-journeys-s3-* Agent, left in place; no destructive actions
est_minutes: 20
smoke_scenarios: []
---

# Journey: auto software engineer

User story: given a task, decide if it's small/simple enough to build unsupervised (build + open PR
+ ask for review) vs. needs a plan shared with a human vs. needs clarification (and route to the
right human — product or engineering).

## S1 — Build the agent; GitHub gap surfaces honestly

| # | Action | Expected |
| --- | --- | --- |
| 1 | In chat, describe the Auto SWE agent (classify Implement/Plan/Clarify; build + PR only for small tasks; never self-merge) and ask it to set up as far as possible without GitHub OAuth | `wait-until` terminal turn (max 90s); answer any clarifying prompt (autonomy level) |
| 2 | `expect` an `agent_create` tool call, and the final response names GitHub as the blocker for branches/commits/PRs | Honest gap-reporting rather than fabricated tool access |
| 3 | `navigate /agents/<created-agent-slug>` | Config renders with a classification-oriented role/constraints |
| 4 | `capture` screenshot | — |

## S2 — Route a trivial task

| # | Action | Expected |
| --- | --- | --- |
| 1 | New chat, `@<agent>` a genuinely trivial task (e.g. a one-word typo fix) | `wait-until` terminal turn (max 60s) |
| 2 | `expect` the transcript shows real work toward the task (file/plan/analysis tool calls), not just a `transfer_to_agent` followed by a one-line "handed off" narration with nothing else | If the latter, this is a P1 finding — cross-check `/runs` for whether a run under the delegated agent's identity was ever created |
| 3 | `capture` screenshot, console delta | — |

## S3 — Route a non-trivial task

| # | Action | Expected |
| --- | --- | --- |
| 1 | New chat, `@<agent>` a task clearly too large to build unsupervised (e.g. "add multi-tenant support") | `wait-until` terminal turn (max 60s) |
| 2 | `expect` a plan/design response shared for human review, not an attempted unsupervised build | — |
| 3 | `capture` screenshot | — |

## S4 — Ambiguous task requiring clarification

| # | Action | Expected |
| --- | --- | --- |
| 1 | New chat, `@<agent>` a vague task with no defined scope (e.g. "make the dashboard better") | `wait-until` terminal turn (max 60s) |
| 2 | `expect` a clarification request naming what's missing (goal/users/acceptance criteria) | — |
| 3 | `note` whether it routes the clarification to a specific human (product vs. engineering) as the story asks, vs. just asking the current requester | In a single-operator staging instance there is no second human to route to, so this sub-behavior is effectively untestable here — record as a limitation of the test environment, not a pass/fail |
| 4 | `capture` screenshot, console delta | — |

## Notes for the runner

- This run found `@mention` delegation (`transfer_to_agent`) frequently does not actually hand
  execution to the target agent — `/runs` kept showing every turn as `agent:assistant`, never the
  delegated agent's identity. S2 is written to catch this; if seen, don't file a fresh issue — check
  for an existing "delegation narrates without doing the work" issue first.
- Never complete real GitHub OAuth. S1's "honest gap" assertion is this journey's ceiling for the
  GitHub-dependent parts of the story.
