# 14 — Noise floor

**What to build:** The measurement that makes the whole framework honest. Run the identical harness
repeatedly, measure how much the score moves on its own, and report any delta inside that band as
**no signal** rather than as an improvement.

This matters more here than it normally would: there is **no temperature, top-p or seed control
anywhere in the model invocation path**, so v1 cannot run at temperature 0. The noise floor is how
we find out whether that is a problem.

**Blocked by:** 08, 11

**Status:** ready-for-agent

- [ ] A Case can declare multiple Trials
- [ ] A Sweep can repeat an unchanged harness to measure run-to-run variance
- [ ] The Scorecard reports a variance band per model
- [ ] A delta inside the band is reported as "no signal", not as an improvement
- [ ] The measured floor is recorded, so the later advisory-to-gate decision is made on evidence.
      A gate whose threshold sits inside the noise band trains maintainers to ignore it, which is
      worse than having no gate
