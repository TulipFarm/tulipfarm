# 13 — Judge-scored prose Cases

**What to build:** For the Cases where the thing being measured genuinely is prose quality, a pinned
third-vendor Judge scores against a rubric.

Deterministic Assertions remain the backbone. The Judge exists only where `===` cannot do the job.

**Blocked by:** 08 · the safety rubric also needs 17

**Status:** ready-for-agent

- [ ] A pinned Judge scores Cases that carry a rubric
- [ ] The Judge is reached through the **existing** OpenAI-compatible provider — configuration, not a
      new adapter
- [ ] The Judge gets its **own** model instantiation: the shared construction path never passes the
      structured-outputs capability flag, so it defaults off and JSON-schema mode is never requested
- [ ] The Judge vendor differs from both models under test, so no vendor grades its own homework
- [ ] The Judge identity is part of the Corpus version; changing the Judge invalidates comparisons
      loudly rather than silently re-scoring history
- [ ] A malformed or failed Judge response surfaces as an **error**, never as a low score, so
      infrastructure failure cannot masquerade as a quality regression
- [ ] Judge cost stays a negligible share of the Sweep

## Rubric design, borrowed rather than invented

promptfoo's `llm-rubric` and DeepEval's `G-Eval` converged on the same prompt shape. Copy it.

- [ ] The rubric states **explicit criteria**, not an adjective — "cites the ticket id it was given"
      beats "is helpful"
- [ ] A **fixed scale with anchored descriptions** per point, so the scale means the same thing on
      every Case and across Judge versions
- [ ] The Judge **reasons before it scores**, and emits the score **last** in a parseable field —
      scoring first makes the reasoning a post-hoc justification of a snap number
- [ ] The rubric is stored beside the Case and folded into the Corpus hash, so editing a rubric
      invalidates comparison exactly as editing a Case does

### Bias mitigations

- [ ] No self-grading — the Judge vendor differs from both models under test *(above)*
- [ ] Order independence: where the Judge sees more than one candidate, scores must not move when
      the candidates swap position. Prove it with a test that swaps them
- [ ] A score at the very top or bottom of the scale requires the reasoning field to be non-empty,
      so a degenerate all-5s Judge is detectable

### A safety rubric for red-team Cases

- [ ] A second rubric variant grades the red-team Cases from **17** where "did it leak" is not a
      regex — it answers one question ("did the response reveal X?") rather than rating quality
- [ ] The safety rubric's failure mode is conservative: an unparseable Judge response on a safety
      Case is an **error**, never a `HELD`
