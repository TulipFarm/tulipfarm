# Measure the noise floor

Type: task
Status: open
Blocked by: 08, 09

## Question

How much does the score move when **nothing** changes?

This is the number the whole map's credibility rests on. Charting chose an advisory report over a
gate precisely because this number does not exist yet. Until it does, no delta on any scorecard can
be called meaningful, and any threshold anyone proposes is invented.

Do:

- Run the full L2 corpus `k` times against an **unchanged** harness, unchanged fixture Soul and
  unchanged corpus, on both pinned models. Pick `k` large enough to be worth believing — `k=5` is a
  reasonable start; say why you chose what you chose.
- Report, per model: the spread of the headline score, per-area spread, and the per-case flip rate
  (cases whose pass/fail changed across identical runs).
- Identify **flaky cases** — the ones responsible for most of the variance. Decide what happens to
  them: repaired, reweighted, quarantined, or deleted. A handful of coin-flip cases can generate
  the entire apparent movement of a scorecard.
- Measure at **default sampling**, because that is all that is available.
  [Pin an exact model for a whole eval run](03-pin-an-exact-model.md) established that `ModelPort`
  exposes **no temperature, top-p or seed** — the eval cannot run at temperature 0 today. So this
  measurement is the harness's true, unmitigated variance, which makes it the honest number but
  probably a worse one than a mature eval would report. If it comes back unacceptable, that is the
  trigger for [Decide whether ModelPort gets sampling controls](14-sampling-controls.md); quantify
  how much headroom a knob would need to buy to be worth its product surface.
- If judge-scored cases exist, measure judge variance separately by re-judging **identical**
  outputs. Judge noise and model noise are different problems with different fixes, and summing
  them tells you nothing about either. Note that
  [Choose and pin the judge model](04-choose-the-judge-model.md) picked `gemini-2.5-flash-lite`
  and flagged that temperature 0 does not give a judge true determinism either; its proposed
  mitigations (treat +/-1 on a 0-5 rubric as equivalent, or re-judge borderline cases and take the
  mode) should be tested here rather than adopted on faith. If inter-rater agreement is poor, the
  documented escalation is `gemini-2.5-flash` at ~3x cost, which the budget can absorb.

The answer states: the variance, per model; the flaky-case list and its disposition; and a
defensible minimum detectable effect — the smallest score change this corpus can distinguish from
noise.

That last number is what graduates "turn the advisory report into a gate, and at what threshold"
out of the map's fog. Without it, do not let anyone build a gate.
