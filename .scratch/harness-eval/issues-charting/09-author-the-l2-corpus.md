# Author the first L2 corpus

Type: grilling
Status: open
Blocked by: 06, 07

## Question

What does the corpus actually measure? Which harness capabilities are worth a case?

This is the ticket that decides whether the whole framework is useful. A runner with the wrong
corpus is a machine that produces a confident number about nothing. The budget from charting is
~$5 a run across both models and both tiers, so L2 gets on the order of 100-150 cases total —
enough to be a real instrument, small enough that every case has to earn its place.

The test for a case: **could a harness change plausibly move it?** The harness owns context
assembly, instruction precedence, guardrails, tool descriptions and the bounded tool loop. A case
that only measures raw model intelligence is noise on your scoreboard — it will move when the
vendor ships a new checkpoint and tell you nothing about your own work.

Candidate areas to grill through, keep or reject:

- **Tool selection** under near-miss pressure — the fixture's deliberately confusable tools.
- **Argument construction** — right tool, wrong or malformed args.
- **Instruction precedence** — Soul instructions vs Agent instructions vs user message in conflict.
  This is `agent-runtime`'s own documented concern and pure harness territory.
- **Context assembly under budget** — the package rule says over-budget blocks are dropped whole.
  Does the agent still succeed when a block was dropped, and does it fail honestly when it needed it?
- **Guardrails** — input, tool and output stages. Note `test/security/adversarial.test.ts` already
  covers injection containment and non-amplification against *scripted* models; decide what a
  *real* model adds and avoid duplicating what free tests already prove.
- **Multi-step tool loops** — does it chain correctly, and does it stop?
- **Knowledge and memory retrieval** — does it cite, and does it use what it retrieved?
- **Refusal and honesty** — declining when the tools cannot do the thing, instead of inventing.
- **Delegation** — helper Agents as child Runs.

Settle in the same session:

- **Weighting.** Equal weight per case, or per area? Uneven case counts across areas silently
  weight the headline number.
- **The headline number.** One score, or a per-area scorecard with no aggregate? A single number is
  what gets watched; a single number also hides which area regressed.
- **Provenance.** Where does a case come from — invented, or harvested from real failures? Decide
  now how a real-world harness bug becomes a new case, or the corpus will never grow.
- **Difficulty spread.** Cases every model passes measure nothing. Cases every model fails measure
  nothing. Aim for headroom, and decide what to do with a case that saturates.

Consult `packages/agent-runtime/AGENTS.md`, `specs/GUARDRAILS.md`, `specs/CONTEXT-ENGINE.md`,
`specs/TOOLS.md`.
