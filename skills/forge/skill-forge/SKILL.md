---
name: skill-forge
description: Search, install, and author safe, reusable Skills.
category: forge
tools: [skill, skill_list, skill_create, skill_update, skill_install, skill_marketplace_browse, skill_source_scan, skill_scanned_audit, skill_scanned_install, web_fetch, present, request_input]
allowedDomains: [raw.githubusercontent.com, skills.sh, www.skills.sh]
---
# Skill Forge Skill

Find, install, or author a Skill: a stateless set of instructions for one repeatable task. This
file carries the rules that bind every one of those jobs; each job's own procedure lives in a
reference you load when you need it. It does not create Agents or Routines.

## When to Use — a Skill is a *what*, an Agent is a *who*

A Skill is a procedure: never addressed by a user, loaded only when its description matches the
task, one active at a time, and it **carries no authority** — it runs under the permissions of the
Agent that loaded it. Declaring `tools` narrows what the model is *shown*, which is focus, not
permission. An Agent is the opposite on every count: addressable, owner of the chat across Turns,
and the only one of the two that can carry an enforced limit. So **a hard limit is never a Skill**
("must never delete a Ticket" is an Agent's `capabilityRestrictions`, checked before the Tool runs,
where Skill text is only advice), and **making an existing Agent better at one task is always a
Skill**, never a second Agent — one Agent uses many Skills, and one Skill serves every Agent whose
`capabilityRestrictions.skills` does not exclude it.

Use this workflow when:

- The user asks how to do something likely already solved, or whether a Skill exists for it.
- The user asks whether you *can* do X, where X is a specialised capability.
- The user wants to capture a repeatable procedure as a Skill.
- The user wants to scan or install Skills from a Git repository or GitHub URL.
- A hard multi-step task produced an approach worth reusing.
- A loaded Skill is wrong, outdated, incomplete, or missing a discovered pitfall.

Switch forge when the user actually wants:

| What they described | Go to | Why it is not a Skill |
| --- | --- | --- |
| A worker to talk to, persistent identity, or a hard limit | `agent-forge` | Nobody addresses a Skill, and only an Agent's limit is enforced |
| Work that starts on a schedule or an event | `routine-forge` | A Skill is loaded, never triggered |
| A new shape of business data | `resource-forge` | That is a Resource type |
| A fact or policy with no procedure | Knowledge or Memory | A Skill says *how*, not *what is true* |
| A one-off answer with no likely reuse | Neither | Answer it; do not write a Skill |

## Prerequisites

- A single task or package with a checkable result.
- Access to `skill`, `skill_list`, `skill_create`, `skill_update`, `skill_install`, `web_fetch`, `skill_marketplace_browse`, `skill_source_scan`, `skill_scanned_audit`, and `skill_scanned_install`.
- A configured LLM provider for new-Skill and package SkillAudit.
- Explicit operator confirmation before any Skill is written or installed.

## How to Run

Identify the job, then load its reference with `skill`, `name: "skill-forge"`, and `file`. The
rules on this page bind every job; the reference carries that job's steps.

| Job | Load | In one line |
| --- | --- | --- |
| Find or install a Skill | `references/finding-a-skill.md` | Official catalogue, then skills.sh, then author it |
| Author a new Skill | `references/authoring-a-skill.md` | Contract, draft, audit, confirm |
| Change a loaded Skill | `references/maintaining-a-skill.md` | Surgical patch by default, rewrite rarely |

**Search before you author, and say what the search returned.** Rung 1 is `web_fetch` on
`https://raw.githubusercontent.com/TulipFarm/skills/refs/heads/main/marketplace.json`, whose source
grades `trusted`. Rung 2, only on a miss, is `web_fetch` on
`https://www.skills.sh/api/search?q=<query>&limit=100`. Rung 3 is authoring one.

**Every write is audit first, then confirm.** `skill_create`, `skill_update` and `skill_install`
each take two calls. The first validates, runs SkillAudit and returns a report plus a `confirm`
token, having written nothing. Show the operator the risk rating and every finding, then call the
same Tool again, repeating the identifiers it needs — `name` for a create or update, `source` plus
`name` for an install — alongside the token. Never resend the body, frontmatter or any other
content: the confirming call must write only what was audited. Each confirming call asks a human.

The scan flow is the exception. `skill_scanned_audit` and `skill_scanned_install` are two different
Tools and neither takes `confirm`, so audit first by calling the former, and still ask the operator
before calling the latter.

{{FORGE_EXECUTION_CONTRACT}}

## Quick Reference

| Need | Tool call | Boundary |
| --- | --- | --- |
| Find existing Skills | Read the Context | Already lists every Skill; no Tool call needed |
| Read one Skill | `skill` + `mode: "inspect"` | Exact patch context, without adopting it |
| Read a reference | `skill` + `name` + `file` | Ships with the package; never loaded automatically |
| Search rung 1 or rung 2 | `web_fetch` + the catalogue or search URL | Read-only; nothing is installed |
| Install from URL or slug | `skill_install` + `source` (+ `name`) | Audits first; writes only on the `confirm` call |
| Browse marketplace | `skill_marketplace_browse` | Returns scanId and skillPath for packages |
| Scan Git source | `skill_source_scan` + `source` | Discovers packages with scanId and skillPath |
| Audit scanned package | `skill_scanned_audit` + `scanId`/`name`/`skillPath` | Review before installation |
| Install scanned package | `skill_scanned_install` + `scanId`/`name`/`skillPath` | Preserves source and ref provenance |
| Audit a new Skill | `skill_create` + `name`/`body`/`frontmatter` | Returns a report and a token; writes nothing |
| Patch one match | `skill_update` + `old_string`/`new_string` | Preferred maintenance path |
| Patch every match | Add `replace_all: true` | Use only when every occurrence should change |
| Rewrite | `skill_update` + complete `body` | Major changes only |
| Write the audited Skill | `skill_create`/`skill_update` + `name`/`confirm` | Human approval required; resend name and token, never content |

Frontmatter rules, which SkillAudit scores and the loader enforces:

- `name`: lowercase letters, numbers, dots, underscores, or hyphens; maximum 64 characters, and it
  must equal the Skill directory name.
- `description`: required; one sentence, maximum 60 characters by house style, ending with a period.
- `tools`: exact Tool names the procedure calls — no more, no fewer. A Skill with no `tools` falls
  back to the full catalog.
- `allowedDomains`: exact hosts the procedure fetches, if any. No wildcards, no URLs, no paths.
  Anything not listed is refused at dispatch.
- Unknown benign fields are tolerated; authority-grant and underscore-prefixed fields are reserved.

Mandatory body section order:

1. `# <Title> Skill`
2. Two or three sentences stating what the Skill does and does not do
3. `## When to Use`
4. `## Prerequisites`
5. `## How to Run`
6. `## Quick Reference`
7. `## Procedure`
8. `## Pitfalls`
9. `## Verification`

Aim for roughly 100 lines. The body loads in full every Turn the Skill is active, so move anything
needed only after a decision into `references/` and point at it from the body.

## Procedure

Every job shares this spine; the reference fills in the middle.

1. **Classify the artifact.** Confirm this is a Skill and not an Agent, Routine, Knowledge Page or
   Memory fact. Switch forge if it is not.
2. **Survey what is already here.** The Context lists every available Skill by name and
   description; read that before anything else. For one Skill's exact body call `skill` with
   `mode: "inspect"` — plain `skill` adopts it and replaces this forge as your active Skill.
3. **Search outward, in order,** when nothing installed fits: rung 1, then rung 2. Report what each
   returned, including that it returned nothing.
4. **Load the job's reference** from the table above and follow it.
5. **Audit before any write.** Call the writing Tool without `confirm`. It returns a report and a
   token, and writes nothing. In the scan flow call `skill_scanned_audit` instead.
6. **Present the audit whole.** Deterministic findings, source trust, risk rating, summary, and
   every warning. Do not summarise a warning away.
7. **Write only after the operator agrees,** repeating the identifiers plus the token and never the
   content. The Tool asks for human approval, so never describe the Skill as written until the call
   returns.
8. **Verify the durable result.** Read it back with `skill` + `mode: "inspect"`.

## Pitfalls

1. **Duplicate creation.** Inspect existing Skills before writing overlapping guidance.
2. **Authoring without searching.** Walk rung 1 and rung 2 first, and report what they returned.
3. **Guessing a procedure the reference holds.** Load the reference; it exists because the details
   are the part that goes wrong.
4. **Recommending on search results alone.** Check installs and publisher. A high install count is
   popularity, not safety.
5. **Installing without audit.** Always call the writing Tool once without `confirm` first.
6. **Hallucinating installation.** Never pretend a Skill was installed without a Tool result.
7. **Vague descriptions.** Describe trigger and outcome, not generic quality claims.
8. **Oversized always-loaded prose.** Keep rules in the body and procedures in references.
9. **Ambiguous patches.** Extend `old_string` until it is unique, or use `replace_all` deliberately.
10. **Accidental rewrites.** Do not submit a complete body for a one-line correction.
11. **Audit overclaiming.** Neither deterministic patterns nor an LLM rating guarantees safety.
12. **Claiming a write that has not happened.** The first call returns a report, not a Skill.
    Nothing exists until the confirmed second call returns.
13. **Abandoning a draft.** Stopping after the audit leaves the Skill unwritten. Carry every audit
    through to a confirmation or an explicit refusal.

## Security rules

These are the rules `SkillAudit` scores against. They bind you twice over: never author a Skill
that trips one, and never install a package that does. A Skill is natural-language instruction an
Agent follows with its full Tool authority, so a capability written into it is a capability
granted — there is no sandbox between the two.

When you author, read each family below as a prohibition, and give the Skill the narrowest reach
its stated purpose can justify. When you review a scanned package, read each family as a question
to answer with a file, a line, and a quote. Do not resolve a finding by weakening the rule.

{{SKILL_AUDIT_TAXONOMY}}

## Verification

- [ ] The request is a Skill rather than an Agent, Routine, Knowledge Page, or Memory fact.
- [ ] Existing Skills were checked and unnecessary duplication was avoided.
- [ ] Before authoring, rung 1 and rung 2 were searched and the result was reported.
- [ ] The job's reference was loaded and followed rather than reconstructed from memory.
- [ ] A skills.sh candidate was verified on installs and publisher, with no invented figures.
- [ ] For any external source, audit ran and every warning was shown before installation.
- [ ] The name matches the directory and satisfies the lowercase 64-character limit.
- [ ] The description is at most 60 characters, one sentence, and ends with a period.
- [ ] `tools` lists exactly the Tools the procedure calls, and `allowedDomains` every host it fetches.
- [ ] The body follows the mandatory section order and has a checkable completion criterion.
- [ ] A new Skill returned both deterministic and LLM SkillAudit evidence.
- [ ] The operator explicitly confirmed before the write, and the confirming call sent only the token.
- [ ] Every security check family was applied — to a Skill authored here, and to any package installed.
- [ ] The final Skill was read back and matches the requested durable behavior.
