# 15 — L3 journeys and state assertions

**What to build:** Multi-Turn journeys that assert on what the product actually **did** — the state
it persisted — rather than only on what it said.

**Blocked by:** 10

**Status:** ready-for-agent

- [ ] Journeys span multiple Turns in one Conversation
- [ ] Assertions read persisted state: Records written, Soul artifacts committed, Run events emitted
- [ ] The tier stays deliberately small; the L2 spine carries the bulk of the signal
- [ ] A full L2 + L3 Sweep stays inside the cost ceiling
- [ ] Research recommended dropping this tier entirely and shipping L2-only; that was explicitly
      overridden because the end-to-end proof was judged worth the cost. Do not relitigate silently
