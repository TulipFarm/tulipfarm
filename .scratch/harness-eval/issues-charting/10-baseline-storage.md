# Baseline storage and delta comparison

Type: grilling
Status: open
Blocked by: 08

## Question

Where do scores live between runs, and how is "did this improve?" computed?

Charting settled that the eval is **advisory** for v1 and that the subject under test is the
harness, with baselines per (harness version x model). The comparison is therefore the product —
the absolute score is nearly meaningless on its own; the delta against a baseline is the whole
point.

Decide:

- **Storage.** A JSON file committed to the repo, so git history *is* the audit trail and the
  scorecard is diffable in the release PR — which matches how this repo already treats the Soul.
  Versus GitHub Actions artifacts, which do not pollute the repo but expire and are awkward to
  diff. Versus something external, which is more machinery than a pre-release eval deserves.
- **What is a baseline.** The previous release's run? The last run on `main`? An explicitly blessed
  run? "Previous release" is the honest comparison for a pre-release gate, but drifts over a long
  release cycle.
- **Invalidation.** A baseline is only comparable if the corpus, the fixture Soul, the pinned
  subject models and the judge model are all unchanged. Decide the composite version that binds
  them, and what the report does when it changes — refuse to compare, or compare only the
  intersection of unchanged cases. Refusing is safer and more annoying; picking wrong here is how
  eval systems start lying.
- **Per-case history.** Store only the latest baseline, or a series? A series makes "is this case
  flaky?" answerable and feeds
  [Measure the noise floor](12-noise-floor.md) — but grows without bound in a public repo.
- **Delta semantics.** Per-case pass/fail flips, per-area aggregates, and the headline. Which of
  these does a maintainer read first? Note that until the noise floor is known, no delta can be
  declared significant — the report must present deltas without implying significance it cannot
  support.
- **Cross-model reading.** The two models are a control, so the report must make "both moved" vs
  "only one moved" immediately visible. That is the single most important thing on the scorecard
  and it should not require arithmetic from the reader.
- **Secrets hygiene.** Committed reports must contain no prompt text, no model output, and no
  customer-shaped data. Decide what is safe to store in a public repo. `agent-runtime`'s existing
  rule — log `promptHash`, never prompt text — is the precedent to follow.
