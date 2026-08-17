# 06 — Eval Soul fixture wired into Context assembly

**What to build:** A frozen, version-controlled Eval Soul that every Sweep measures against, read by
the real Soul loader into the catalogue that feeds the Context assembler. Cases stop being
self-contained and start naming a real Agent.

Hand-authoring this fixture is permitted: the product-surfaces rule constrains the **runtime** Soul
repo, not a fixture outside it.

**Blocked by:** 03

**Status:** ready-for-agent

- [ ] A frozen fixture Soul is version controlled, outside the runtime soul repo, and initialised as
      a real git repository — the Soul writer requires one, and L3 will need it
- [ ] It defines its own Agents, Skills, Resource types, Routines and guardrails
- [ ] The real Soul loader reads it; the eval does not construct the catalogue by hand
- [ ] An Eval Case names an Agent in the Eval Soul
- [ ] A change to the fixture changes the Corpus version, so a fixture edit cannot silently
      invalidate a comparison
