---
name: skill-forge
description: Create and improve safe, reusable Skills.
category: forge
tools: [skill_list, skill_get, skill_create, skill_update, skill_activate, present, request_input]
---
# Skill Forge Skill

Create or improve a Skill: a stateless set of instructions for one repeatable task. This workflow
covers duplicate checks, authoring, surgical maintenance, SkillAudit, operator confirmation, and
verification; it does not create Agents or Routines.

## When to Use

- The user wants to capture a repeatable procedure as a Skill.
- A hard multi-step task produced an approach worth reusing.
- A loaded Skill is wrong, outdated, incomplete, or missing a discovered pitfall.
- An existing Skill needs a focused wording or command correction.

Do not use this workflow for:

- Persistent identity, persona, or coordination across Turns; use `agent-forge`.
- Scheduled or event-driven automation; use `routine-forge`.
- A one-off answer with no likely reuse.
- General facts without a procedure; store those in the appropriate Knowledge or Memory surface.

## Prerequisites

- A single task with a checkable result.
- Access to `skill_list`, `skill_get`, `skill_create`, `skill_update`, and `skill_activate`.
- A configured LLM provider for new-Skill SkillAudit.
- Explicit operator confirmation before activating a newly created Skill.

## How to Run

- For a new Skill, follow the create procedure and stop for operator confirmation after SkillAudit.
- For a small correction, call `skill_update` with `old_string` and `new_string`.
- For repeated exact text, add `replace_all: true`; otherwise the match must be unique.
- For a major overhaul, supply a complete `body` and, only when needed, complete `frontmatter`.
- A bundled Skill is read-only until `skill_update` materializes a Soul override automatically.

{{FORGE_EXECUTION_CONTRACT}}

## Quick Reference

| Need | Tool call | Boundary |
| --- | --- | --- |
| Find existing Skills | `skill_list` | Inspect before creating |
| Read one Skill | `skill_get` | Capture exact patch context |
| Create | `skill_create` | Lands pending audit |
| Patch one match | `skill_update` + `old_string`/`new_string` | Preferred maintenance path |
| Patch every match | Add `replace_all: true` | Use only when every occurrence should change |
| Delete matched text | Set `new_string: ""` | Final body must remain non-empty |
| Rewrite | `skill_update` + complete `body` | Major changes only |
| Activate | `skill_activate` | Only after operator reviews SkillAudit |

- `name`: lowercase letters, numbers, dots, underscores, or hyphens; maximum 64 characters.
- `name` must equal the Skill directory name; `description` is required.
- `description`: one sentence, maximum 60 characters by house style, ending with a period.
- `tools`: the array of exact Tool names this Skill's procedure actually calls — required for every
  new Skill. Once loaded, the loop offers the model only this list, plus the always-exposed baseline
  (`load_skill`, `complete_task`, `delegate_to_agent`, `present`, `request_input`,
  `update_presentation`), plus every mutating Tool the Agent holds — a Skill scope may hide a read
  and never a write. Omitting a *read* the procedure calls makes that call unreachable while the
  Skill is active. Do not list one the procedure never calls. A Skill with no `tools` declared falls
  back to the full catalog — every Skill should declare its list rather than rely on that fallback.
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

Aim for roughly 100 lines for a simple Skill. Move bulky or branch-specific material into
`references/` and point to it from the body.

## Procedure

1. **Classify the artifact.**
   Confirm the request is a stateless, repeatable task. If it needs identity or scheduling, switch
   to the matching forge before writing anything.
2. **Survey the merged Skill view.**
   Call `skill_list`, then read likely overlaps with `skill_get`. Completion criterion: the new
   Skill has a distinct trigger, or the existing Skill selected for maintenance is identified.
3. **Define the contract.**
   Write input assumptions, ordered actions, expected output, failure handling, and a checkable
   finish condition. Remove generic advice that would not change Agent behavior.
4. **Draft compact frontmatter and body.**
   Follow the Quick Reference constraints and mandatory section order. Keep the description
   trigger-focused and put procedure details in the body or references. List every Tool the
   procedure calls under `tools`; leave out any the procedure never calls.
5. **Choose create, patch, or rewrite.**
   Use create only for a distinct Skill. For maintenance, prefer a surgical patch containing
   enough exact surrounding text to match once. Use a full rewrite only when the structure itself
   must change.
6. **Create and audit a new Skill.**
   Call `skill_create` with `name`, `body`, and complete public `frontmatter`. It writes a
   pending-audit Skill and returns deterministic scanner evidence plus the LLM SkillAudit report.
   If it returns `audit_required`, report that an LLM provider must be configured and do not claim
   the Skill is live.
7. **Present the independent audit signals.**
   Show the operator the deterministic verdict and findings, source trust, LLM risk rating, and
   summary. State that both are advisory rather than guarantees.
8. **Activate only after confirmation.**
   Once the operator explicitly confirms, call `skill_activate`. Completion criterion:
   `skill_activate` succeeds and the Skill no longer has pending-audit status.
9. **Maintain loaded Skills immediately.**
   When a loaded Skill proves wrong, outdated, or incomplete, call `skill_update` with the exact
   `old_string` and corrected `new_string`. Existing confirmed Skills retain their audit state and
   are not re-audited on update.
10. **Verify the durable result.**
    Read the Skill again with `skill_get`. Confirm the intended content, frontmatter, provenance,
    and activation state from real Tool results.

## Pitfalls

1. **Duplicate creation.** A new name does not make overlapping guidance distinct. Inspect first.
2. **Vague descriptions.** Describe the trigger and outcome, not generic quality claims.
3. **Oversized always-loaded prose.** Keep core behavior in the body and details in references.
4. **Ambiguous patches.** Add surrounding lines until `old_string` is unique, or deliberately use
   `replace_all` when every occurrence must change.
5. **Accidental rewrites.** Do not submit a complete body for a one-line correction.
6. **Broken structure after deletion.** An empty `new_string` is valid, but the resulting body and
   serialized SKILL.md must still pass validation.
7. **Audit overclaiming.** Neither deterministic patterns nor an LLM rating guarantees safety.
8. **Premature activation.** A new Skill stays pending until the operator reviews and confirms it.

## Verification

- [ ] The request is a Skill rather than an Agent, Routine, Knowledge Page, or Memory fact.
- [ ] Existing Skills were checked and unnecessary duplication was avoided.
- [ ] The name matches the directory and satisfies the lowercase 64-character limit.
- [ ] The description is at most 60 characters, one sentence, and ends with a period.
- [ ] `tools` lists exactly the Tools the procedure calls — no more, no fewer.
- [ ] The body follows the mandatory section order and has a checkable completion criterion.
- [ ] A surgical update used an exact unique match or an intentional `replace_all`.
- [ ] A new Skill returned both deterministic and LLM SkillAudit evidence.
- [ ] The operator explicitly confirmed before `skill_activate`.
- [ ] The final Skill was read back and matches the requested durable behavior.
