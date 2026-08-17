# 01 — Provision eval credentials and the protected Environment

**What to build:** A maintainer-only trust boundary for eval spend. A protected GitHub Environment
holds the three model credentials behind required reviewers, so a Sweep can only be triggered by
someone the repository owner named, and a fork can never read the keys.

This repository is public and no CI job here has ever called a real LLM. This ticket is the
precondition that makes every later ticket safe to merge.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent — but **human-only**: this is browser work in GitHub settings and
cannot be delegated to an agent.

- [ ] A GitHub Environment exists with required reviewers configured
- [ ] It holds credentials for the Anthropic model, the OpenAI model, and the Judge vendor
- [ ] Variable names match exactly what the provider layer reads from the process environment — the
      layer strips the `env://` prefix and reads the variable verbatim, so a near-miss name fails
- [ ] The existing bootstrap-seeding variable is confirmed unrelated and is not reused
- [ ] Credentials are Environment secrets, never repository secrets, so no ordinary workflow reads them
- [ ] Vendor-side spend limits are set on each account — the reviewer gate stops casual triggering
      but not a runaway loop inside an approved Sweep
- [ ] `pull_request_target` is confirmed absent from any workflow that could reach these secrets
- [ ] The same variable names are documented for local use
