# GitHub issue triage

End-to-end example: a GitHub webhook arrives, an Agent classifies the issue, and the Routine
labels it, opens a Jira ticket, and — behind a human Approval — assigns or closes it.

It exists to show the whole vertical working together on real provider semantics, not to be
copied verbatim: the repository, project key, and account ids are placeholders.

## Files

| File | What |
| --- | --- |
| `routine.yaml` | The 13-state Routine. Every external write is a `tool` State. |
| `agent.yaml` | The classifying Agent — `propose_actions`, no write Tools. |
| `AGENT.md` | Its instructions, including the untrusted-input rules. |
| `integration.yaml` / `access-grant.yaml` | GitHub installation + what may be done to which repository. |
| `integration-jira.yaml` / `access-grant-jira.yaml` | Jira site + the single project it may write to. |

## Flow

```
ReadIssue → FindDuplicates → ClassifyIssue → RouteOutcome
                                              ├─ duplicate → ReplyDuplicate → ApproveClose → CloseIssue
                                              └─ new       → ApplyLabels → CheckAvailability → CreateTicket
                                                             → ApproveAssignment → AssignIssue → ReplyTriaged
```

`RouteOutcome` branches on the Agent's `duplicate` field. Both paths end at a State that is
either an end State or gated by an Approval.

## What this example is actually demonstrating

- **The Agent proposes, the Broker performs.** `ClassifyIssue` returns a schema-bound object. It
  holds no write Tools, so a compromised or confused classification cannot itself mutate anything
  — it can only produce input the Routine then submits for authorization.
- **Untrusted input stays untrusted.** Issue text is attacker-controlled. Because the classifier's
  output is taint-marked, every mutation derived from it escalates to high risk, which is why
  closing and assigning require two approvers rather than one.
- **Approval sits before the irreversible step, with evidence.** `CheckAvailability` runs *before*
  `ApproveAssignment` so the approver sees each candidate's open-issue count, and `ReplyDuplicate`
  runs before `ApproveClose` so the reporter has an explanation even if the close is rejected.
- **Authority is an intersection, not a credential.** The credential could touch the whole
  installation. The AccessGrant narrows it to one repository and six actions; the Jira grant to one
  project and two. Removing a grant stops the writes even though the credential still works.
- **Secrets stay references.** `credentialRef` is a `secret://` pointer. Plaintext is leased for a
  single authorized dispatch and never enters the Soul, a prompt, a log, an audit payload, or an
  Artifact.
- **Every mutation is replay-safe.** GitHub writes carry a hidden `<!-- tulipfarm-effect:… -->`
  marker and Jira creates carry a `tulipfarm-effect-…` label, both read back before writing. A
  redelivered webhook, a retry, or a resumed Run converges on one comment and one ticket.
- **Ambiguity is a state, not a guess.** A provider failure after the request left resolves to
  `ambiguous`, and reconciliation — not a retry — decides whether it applied.

## Running it

Exercised by `apps/worker/test/e2e/github-jira-triage/` against in-memory GitHub and Jira fakes
that enforce the real provider contracts (signature verification, label/marker idempotency,
pagination, failure phases).

```bash
pnpm --filter @tulipfarm/worker test
```
