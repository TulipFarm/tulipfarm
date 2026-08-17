# 07 — Second vendor and the model matrix

**What to build:** The Corpus runs against both vendors, and the Scorecard shows them side by side,
so a harness change that helps one model and hurts the other is visible.

**Blocked by:** 05

**Status:** ready-for-agent

- [ ] The same Corpus executes against both the Anthropic and the OpenAI model
- [ ] The Scorecard reports per-model results side by side
- [ ] Models are selectable at trigger time, so a cheap single-model smoke check is possible
- [ ] Per-model cost is reported separately
- [ ] The Scorecard does not invite a "which model is better" reading — the two models are a
      **control** on the harness measurement, not competitors
