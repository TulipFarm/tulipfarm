# Design the eval case format

Type: prototype
Status: open
Blocked by: —

## Question

What does one eval case look like on disk?

Make a cheap, concrete artifact to react to — two or three real case files written out in full,
for both tiers — rather than arguing about the schema in the abstract.

The format has to carry:

- **Identity and version.** A case id, and a version that changes whenever expectations change.
  Silent edits to expectations are how eval corpora rot: last month's score stops meaning what it
  said. Decide whether a case version bump invalidates the baseline for that case alone or resets
  the whole corpus.
- **Tier.** L2 (one turn, faked tools and storage) or L3 (real journey).
- **Input.** For L2: which fixture Agent, what user message, what conversation history if any,
  what the faked tools return. For L3: the sequence of user messages.
- **Deterministic assertions.** The backbone. This is the hard part of the design: an assertion
  language expressive enough for "called `resource_create` with a `name` matching /ticket/i,
  before any `kv_set`, within 6 loop iterations, without tripping a guardrail" — and still
  readable by a human authoring the 40th case. Charting established the observable signals:
  `AgentLoopEvent`s, `ToolDispatchPort` calls, `ModelUsage` (tokens, cache reads, `costUsd`),
  guardrail outcomes, and for L3, Run events and resulting Records.
- **Judge rubric.** Optional, only for prose cases. What the judge is asked and how its verdict
  becomes a score.
- **Weight and severity.** Does every case count equally toward the headline number?

Decide alongside:

- **Encoding.** YAML (matches the Soul's authoring style, readable, but assertions become a
  stringly-typed DSL you have to write a parser and validator for) versus TypeScript (assertions
  are just typed predicate functions, free editor support and typecheck, no DSL to build — but
  cases stop being data you can diff cleanly or generate). Prototype at least one case **both**
  ways before choosing; this is exactly the decision that is obvious once you see it and endlessly
  arguable before.
- **Schema validation.** If YAML, does the shape live in `packages/schema` as TypeBox like every
  other config in this repo?
- **Layout.** One file per case, or grouped by capability area?
- **Scoring output.** What a single case result record contains, since the report and the baseline
  are both built from it.

Consult `packages/agent-runtime/src/loop/contract.ts` for the event and dispatch shapes,
`packages/agent-runtime/test/security/adversarial.test.ts` for how existing assertions on the loop
are written today, and `packages/schema/AGENTS.md`.

Link the prototype files from the answer.
