# 12 — Maintainer-only CI trigger

**What to build:** The second front door. A maintainer triggers a Sweep from the Actions UI; it
pauses for a reviewer, runs, and leaves the Scorecard attached to the job.

**Blocked by:** 01, 07

**Status:** ready-for-agent

- [ ] A `workflow_dispatch` workflow runs a Sweep, gated on the protected Environment
- [ ] It pauses for a required reviewer before spending anything
- [ ] Tier and models are inputs at trigger time
- [ ] The Scorecard is uploaded as an artifact and summarised in the job
- [ ] A fork's pull request can neither trigger it nor read the credentials
- [ ] Local and CI execute the **same** runner code, so a green local result is not quietly
      different from a green CI result
- [ ] Wall-clock time is bounded, so a hung vendor call cannot block a release indefinitely
