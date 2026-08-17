# 11 — Baseline storage and deltas

**What to build:** A Scorecard stops being an absolute number nobody can interpret and becomes a
**change** against a stored reference.

**Blocked by:** 07

**Status:** ready-for-agent

- [ ] A Scorecard can be explicitly promoted to Baseline — nothing becomes Baseline automatically,
      so a bad run never silently becomes the reference
- [ ] Baselines are stored per harness version and per model
- [ ] The Scorecard shows the delta against the Baseline, per Case and in aggregate
- [ ] A Corpus version mismatch **refuses** to compute a delta and fails loudly. Silent re-scoring
      against a different Corpus or Judge is the most dangerous failure available here, because it
      produces a confident and entirely fictitious number
- [ ] A Corpus edit therefore cannot manufacture a fake improvement
- [ ] The Scorecard is a durable, archivable artifact
