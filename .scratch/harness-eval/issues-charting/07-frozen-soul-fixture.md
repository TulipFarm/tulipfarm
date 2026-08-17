# Build the frozen eval Soul fixture

Type: prototype
Status: open
Blocked by: 02, 06

## Question

What is in the frozen eval Soul, and what makes it a good instrument?

Settled at charting: the eval runs against a version-controlled, eval-only Soul fixture, never the
shipped default Soul — two moving parts make a score change unattributable. This is permitted:
`AGENTS.md` bans hand-writing into the *runtime* `soul/` repo, but explicitly allows automated
fixtures outside it.

`SoulLoader` (`packages/soul/src/published-loader.ts`) reads a plain directory expecting
`soul.yaml`, `guardrails.yaml`, `agents/*/AGENT.md`, `skills/*/SKILL.md`, `resources/*/schema.yml`,
`routines/*/routine.yaml`, `integrations/*/manifest.yml`. Build that tree.

Design it as an **instrument**, which is a different goal from a realistic Soul:

- **Enough surface to discriminate.** Too few tools and every model scores 100%; the corpus can
  never show a harness improvement because there is no headroom. Too many and cases become about
  tool-name confusion rather than the harness. Decide how many tools, agents and resource types.
- **Deliberate near-misses.** Pairs of similarly-named tools, or overlapping resource types, so
  the corpus can measure whether the harness's tool descriptions and context assembly actually help
  the model discriminate. This is where harness improvements should show up.
- **Stability.** Editing the fixture must reset baselines. Decide how the fixture's version is
  expressed and how it binds to a baseline.
- **Vendor neutrality.** Nothing phrased in a way that suits one vendor's prompt conventions.
- **Guardrails.** `guardrails.yaml` is loadable — should the fixture exercise the guardrail path,
  or keep it at defaults so guardrails do not confound the score?
- **L3 surface.** The journeys authored in [Author the L3 journeys](16-author-l3-journeys.md) need
  something to build against, and
  [Establish headless Run execution for the L3 tier](05-l3-headless-execution.md) confirmed the
  tier is in scope. Note its finding that Soul writes go only through `SoulWriter.apply()` and
  need a real git repo — so the fixture must be a git repo, not just a directory.

Also settle: does the fixture live inside the eval workspace decided by
[Site the eval workspace and its import surface](02-site-the-eval-workspace.md), and does its
`soul.yaml#llm` block carry the pinned model config from
[Pin an exact model for a whole eval run](03-pin-an-exact-model.md), or is that injected?

Link the fixture directory from the answer.
