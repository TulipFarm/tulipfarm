# 16 — Sampling controls

**What to build:** Thread temperature and seed through the model invocation path — **but only if the
measured noise floor says it is worth it.**

Sequenced deliberately after 14 so the decision is made on evidence rather than instinct. If the
floor is acceptable without sampling controls, widening the model path is not worth its blast radius.

**Blocked by:** 14

**Status:** ready-for-agent

- [ ] The decision is taken against the measured noise floor. If the floor is acceptable, this ticket
      is **closed unbuilt** with the reason recorded — that is a valid outcome, not a failure
- [ ] If built: temperature and seed are carried on the model invocation request and accepted by the
      provider factory. Neither carries any such field today
- [ ] Defaults are unchanged for product traffic
- [ ] The eval pins them explicitly
- [ ] The noise floor is re-measured afterwards to show the change actually worked
