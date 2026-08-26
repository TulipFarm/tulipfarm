# Finding a Skill

The long form of the three-rung search in `SKILL.md`. Read it when a search returns nothing useful,
when a candidate needs vetting, or when you are about to recommend a community package.

## Framing the search

Name three things before you fetch anything:

1. **Domain** — React, testing, design, deployment, bookkeeping, support.
2. **Task** — writing tests, reconciling accounts, reviewing PRs, drafting outreach.
3. **Commonness** — is this ordinary enough that someone has already solved it? If it is specific to
   this business, rung 3 is the honest answer and searching twice only delays it.

Search on specific keywords: `react testing` beats `testing`. When a term returns nothing, try its
neighbours — `deploy`, `deployment`, `ci-cd`; `invoice`, `invoicing`, `receivables`. Two or three
phrasings is enough; more is a sign the thing does not exist yet.

## Rung 1 — the official TulipFarm catalogue

`web_fetch` `https://raw.githubusercontent.com/TulipFarm/skills/refs/heads/main/marketplace.json`.

Pass a `prompt` naming the domain and task, so a long catalogue is shrunk against what you want
rather than arriving whole.

Shape:

```json
{ "version": 1,
  "skills": [ { "id": "tulipfarm/skills/finance/invoicing",
                "skillId": "invoicing",
                "name": "invoicing",
                "version": "1.0.0",
                "description": "...",
                "source": "tulipfarm/skills",
                "category": "finance" } ] }
```

Install a match with `skill_install`, `source: "tulipfarm/skills"`, `name: <skillId>`.

`tulipfarm/skills` grades `trusted`, so a hit here carries no reputation question — only the
standard audit and the operator's confirmation.

## Rung 2 — skills.sh

Only once rung 1 has nothing.

- Search: `web_fetch` `https://www.skills.sh/api/search?q=<query>&limit=100`, with a `prompt`
  naming what you want out of the results. It answers with
  `{ query, searchType, count, skills: [ { id, skillId, name, installs, source } ] }`, where `id`
  is `<source>/<skillId>`. Note there is **no description** — unlike rung 1, the search tells you a
  Skill exists and how popular it is, not what it does.
- Broad domain question: `web_fetch` `https://skills.sh/` first. The leaderboard ranks by total
  installs and surfaces the battle-tested options — for web work, `vercel-labs/agent-skills` and
  `anthropics/skills` sit at the top with 100K+ installs each.

### Verify before recommending

A search result is a claim, not a review. Check every candidate on two axes:

| Axis | Prefer | Treat with suspicion |
| --- | --- | --- |
| Installs | 1K+ | Under 100 |
| Publisher | `vercel-labs`, `anthropics`, `microsoft`, other known names | Unknown author |

Those are the two axes the search response actually carries. Do not claim a star count or a
repository age you have not fetched — you cannot reach `github.com` from here, so an unsourced
number would be invented.

Failing one axis is not disqualifying on its own — a new Skill from a known publisher is fine. Both
failing is a package you should not put in front of the operator.

None of this replaces SkillAudit. Popularity measures adoption, not safety, and a 100K-install
package still gets audited and still has every warning read out in full.

## Presenting what you found

Per candidate, give the operator:

1. The name and what it does, in one sentence. Rung 1 gives you a `description` to use. Rung 2 does
   not, so say what the name and source suggest and mark it as unconfirmed — never invent a
   capability the catalogue did not state.
2. Its install count and source.
3. A skills.sh link so they can read more.
4. For a rung 2 candidate, the audit's risk rating and **every** warning, verbatim.

Then ask. Do not install on your own judgement, however safe the package looks.

Example:

> I found a Skill that might help. `react-best-practices` covers React and Next.js performance
> optimisation, from Vercel Engineering — 185K installs, source `vercel-labs/agent-skills`.
> Want me to audit and install it?

## Installing

- Rung 1: `skill_install` with `source: "tulipfarm/skills"` and `name: <skillId>`.
- Rung 2: `skill_install` with the skills.sh page URL as `source`. It resolves to the backing GitHub
  repository on its own. Add `#branch` or `#tag` to pin a ref.
- Either way the first call audits and writes nothing. The second call is the one that writes and
  the one that asks a human — repeat `source` and `name` on it, alongside the `confirm` token the
  first call returned. `source` is required on every call; sending the token alone fails.
- Use `skill_source_scan` plus `skill_scanned_audit` and `skill_scanned_install` instead when the
  operator wants to look through a whole repository rather than install one named Skill.

## When nothing fits

Say so plainly, then author the Skill with `skill_create` and the rest of the `SKILL.md` workflow.

Read the near-misses first. Their section order, their pitfalls list and their verification
checklist are worth borrowing even when none of their content is.
