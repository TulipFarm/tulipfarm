# Set up the maintainer-only trigger

Type: task
Status: open
Blocked by: 04

## Question

Stand up the trust boundary in GitHub so only the right people can spend the money.

Mostly HITL: the agent can write the workflow scaffolding and document the steps, but creating an
Environment, adding reviewers and pasting API keys must be done by a repo admin in the GitHub UI.
This ticket unblocks nothing until the keys physically exist, which is why it is worth doing early
rather than discovering it on release day.

Facts established at charting:

- `TulipFarm/tulipfarm` is **public**, has **no** `CODEOWNERS`, and `ci.yml` references no secrets.
- `workflow_dispatch` on a public repo **already** requires write access to trigger. Forkers are
  locked out for free; no actor allowlist is needed, and writing one by hand is a common way to get
  this wrong.
- No CI job in this repo has ever called a real LLM. This is the first.

Do:

- Create a protected GitHub **Environment** (say `eval`) with required reviewers, so even a
  committer cannot spend the budget without a second person approving. The reviewer gate is the
  real control; `workflow_dispatch` write access is only the outer fence.
- Add the API keys as Environment secrets — anthropic, openai, and the judge key named by
  [Choose and pin the judge model](04-choose-the-judge-model.md). Confirm the env var names match
  what [Pin an exact model for a whole eval run](03-pin-an-exact-model.md) determined `env://` refs
  expect.
- Set a spend limit or a separate billing project per key where the vendor supports it. The
  Environment gate stops casual triggering; it does not stop a runaway loop, and a leaked key is a
  bill, not an inconvenience.
- Document the whole setup — `apps/docs` or a `CONTRIBUTING.md` section — so the next maintainer
  can reproduce it. An undocumented Environment is a single point of failure wearing a hat.
- Verify the boundary empirically: confirm a fork's PR cannot reach the secrets, and that
  `pull_request_target` is **not** used anywhere near this workflow. Getting that wrong is the
  standard way public repos leak keys.

Do **not** write the eval job itself here — that is fog on the map until the runner and scorecard
shapes exist. This ticket delivers the boundary and the credentials, nothing more.
