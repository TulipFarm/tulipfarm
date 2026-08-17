# 08 — Author the L2 spine Corpus

**What to build:** Grow the Corpus from a single Case to real coverage of harness behaviour. This is
the tier that carries the bulk of the signal.

**Blocked by:** 05, 06

**Status:** ready-for-agent

- [ ] Cases cover Tool selection, Tool argument correctness, and call ordering
- [ ] Cases cover guardrail refusal, so a Context change that weakens a guardrail is caught
- [ ] Cases cover structured output shape and content
- [ ] Cases cover Skill narrowing of model-visible Tools
- [ ] Every Case passes on both models, or its failure is understood and recorded rather than left
      ambiguous
- [ ] A full L2 Sweep stays inside the cost ceiling
- [ ] One Case failing does not abort the Sweep — one bad Case must not cost the whole run's
      information
