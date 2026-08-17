# 13 — Judge-scored prose Cases

**What to build:** For the Cases where the thing being measured genuinely is prose quality, a pinned
third-vendor Judge scores against a rubric.

Deterministic Assertions remain the backbone. The Judge exists only where `===` cannot do the job.

**Blocked by:** 08

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
