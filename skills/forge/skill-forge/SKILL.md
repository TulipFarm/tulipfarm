---
name: skill-forge
description: Create, install, and improve safe, reusable Skills.
category: forge
tools: [skill, skill_list, skill_create, skill_update, skill_marketplace_browse, skill_source_scan, skill_scanned_audit, skill_scanned_install, present, request_input]
---
# Skill Forge Skill

Create, install, or improve a Skill: a stateless set of instructions for one repeatable task. This
workflow covers marketplace discovery, git source scanning, authoring, surgical maintenance,
SkillAudit, operator confirmation, and verification; it does not create Agents or Routines.

## When to Use

- The user wants to capture a repeatable procedure as a Skill.
- The user wants to browse the marketplace or scan/install Skills from a Git repository or GitHub URL.
- A hard multi-step task produced an approach worth reusing.
- A loaded Skill is wrong, outdated, incomplete, or missing a discovered pitfall.
- An existing Skill needs a focused wording or command correction.

Do not use this workflow for:

- Persistent identity, persona, or coordination across Turns; use `agent-forge`.
- Scheduled or event-driven automation; use `routine-forge`.
- A one-off answer with no likely reuse.
- General facts without a procedure; store those in the appropriate Knowledge or Memory surface.

## Prerequisites

- A single task or package with a checkable result.
- Access to `skill`, `skill_list`, `skill_create`, `skill_update`, `skill_marketplace_browse`, `skill_source_scan`, `skill_scanned_audit`, and `skill_scanned_install`.
- A configured LLM provider for new-Skill and package SkillAudit.
- Explicit operator confirmation before any Skill is written or installed.

## How to Run

- For marketplace discovery, call `skill_marketplace_browse`, audit with `skill_scanned_audit`, and install with `skill_scanned_install`.
- For Git/GitHub sources, call `skill_source_scan` with the repository URL, audit with `skill_scanned_audit`, and install with `skill_scanned_install`.
- For a new Skill, call `skill_create` for its audit, then call it again with the `confirm` token it returned once the operator agrees. Nothing is written until that second call.
- For a small correction, call `skill_update` with `old_string` and `new_string`.
- For repeated exact text, add `replace_all: true`; otherwise the match must be unique.
- For a major overhaul, supply a complete `body` and, only when needed, complete `frontmatter`.
- A bundled Skill is read-only until `skill_update` materializes a Soul override automatically.

{{FORGE_EXECUTION_CONTRACT}}

## Quick Reference

| Need | Tool call | Boundary |
| --- | --- | --- |
| Find existing Skills | Read the Context | Already lists every Skill; no Tool call needed |
| Read one Skill | `skill` + `mode: "inspect"` | Exact patch context, without adopting it |
| Browse marketplace | `skill_marketplace_browse` | Returns scanId and skillPath for packages |
| Scan Git source | `skill_source_scan` + `source` | Discovers packages with scanId and skillPath |
| Audit scanned package | `skill_scanned_audit` + `scanId`/`name`/`skillPath` | Review before installation |
| Install scanned package | `skill_scanned_install` + `scanId`/`name`/`skillPath` | Preserves source and ref provenance |
| Audit a new Skill | `skill_create` + `name`/`body`/`frontmatter` | Returns a report and a `confirm` token; writes nothing |
| Patch one match | `skill_update` + `old_string`/`new_string` | Preferred maintenance path |
| Patch every match | Add `replace_all: true` | Use only when every occurrence should change |
| Delete matched text | Set `new_string: ""` | Final body must remain non-empty |
| Rewrite | `skill_update` + complete `body` | Major changes only |
| Write the audited Skill | `skill_create`/`skill_update` + `name`/`confirm` | Human approval required; send the token alone, never the body again |

- `name`: lowercase letters, numbers, dots, underscores, or hyphens; maximum 64 characters.
- `name` must equal the Skill directory name; `description` is required.
- `description`: one sentence, maximum 60 characters by house style, ending with a period.
- `tools`: exact Tool names the procedure calls. A Skill with no `tools` falls back to full catalog.
- Unknown benign fields are tolerated; authority-grant and underscore-prefixed fields are reserved.

Body section order:

1. `# <Title> Skill`
2. Two or three sentences stating what the Skill does and does not do
3. `## When to Use`
4. `## Prerequisites`
5. `## How to Run`
6. `## Quick Reference`
7. `## Procedure`
8. `## Pitfalls`
9. `## Verification`

Aim for roughly 100 lines for a simple Skill. Move bulky material into `references/`.

## Procedure

1. **Classify the artifact.** Confirm repeatable task or package install; switch forge if needed.
2. **Survey existing or discover external packages.** The Context already lists every available
   Skill by name and description; read that first. For one Skill's exact body call `skill` with
   `mode: "inspect"` — plain `skill` adopts it and replaces the forge as your active Skill. For
   external packages call `skill_marketplace_browse` or `skill_source_scan`.
3. **Audit external packages before install.** Call `skill_scanned_audit` with exact `scanId`, `name`, and `skillPath`. Present findings and risk rating to the operator.
4. **Install audited external package.** Call `skill_scanned_install` with `scanId`, `name`, and `skillPath`. It writes to Soul and pins provenance in `skills-lock.json`.
5. **Define authored contract.** Write inputs, actions, output, errors, and finish condition.
6. **Draft frontmatter and body.** Follow section order. List only needed tools under `tools`.
7. **Choose create, patch, or rewrite.** Use surgical patch for small fixes; rewrite for overhauls.
8. **Audit a new Skill.** Call `skill_create` with `name`, `body`, and `frontmatter`. It runs
    SkillAudit and returns a report plus a `confirm` token. It writes nothing.
9. **Present audit signals.** Show deterministic findings, source trust, risk rating, and summary.
10. **Write only after confirmation.** Call `skill_create` again with `name` and that `confirm`
    token. Send the token alone — repeating the body would write text nobody audited. The Tool
    requires human approval, so never describe a Skill as created until the call returns.
11. **Maintain loaded Skills the same way.** `skill_update` with `old_string` and `new_string`
    audits the edit and returns a token; the Skill changes only when you confirm it. A token is
    single-use and expires, so re-audit rather than reusing one.
12. **Verify the durable result.** Read the written body back with `skill` + `mode: "inspect"`.

## Pitfalls

1. **Duplicate creation.** Inspect existing skills before creating overlapping guidance.
2. **Installing without scan or audit.** Always run `skill_source_scan` / `skill_marketplace_browse` first, then `skill_scanned_audit` before `skill_scanned_install`.
3. **Hallucinating installation.** Never pretend a skill was installed without tool execution.
4. **Vague descriptions.** Describe trigger and outcome, not generic quality claims.
5. **Oversized always-loaded prose.** Keep core behavior in the body and details in references.
6. **Ambiguous patches.** Add surrounding lines until `old_string` is unique, or use `replace_all`.
7. **Accidental rewrites.** Do not submit a complete body for a one-line correction.
8. **Broken structure after deletion.** An empty `new_string` is valid, but body must remain valid.
9. **Audit overclaiming.** Neither deterministic patterns nor an LLM rating guarantees safety.
10. **Claiming a write that has not happened.** The first call returns a report, not a Skill.
    Nothing exists until the confirmed second call returns.
11. **Abandoning a draft.** Stopping after the audit leaves the Skill uncreated and the edit
    unapplied. Carry every audit through to a confirmation or an explicit refusal.

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
- [ ] For marketplace or Git sources, scanning and audit were performed before installation.
- [ ] The name matches the directory and satisfies the lowercase 64-character limit.
- [ ] The description is at most 60 characters, one sentence, and ends with a period.
- [ ] `tools` lists exactly the Tools the procedure calls — no more, no fewer.
- [ ] The body follows the mandatory section order and has a checkable completion criterion.
- [ ] A surgical update used an exact unique match or an intentional `replace_all`.
- [ ] A new Skill returned both deterministic and LLM SkillAudit evidence.
- [ ] The operator explicitly confirmed before the write, and the confirming call sent only the token.
- [ ] Every security check family was applied — to a Skill authored here, and to any package installed.
- [ ] The final Skill was read back and matches the requested durable behavior.
