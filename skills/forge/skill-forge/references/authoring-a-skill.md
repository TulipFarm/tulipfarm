# Authoring a Skill

The long form of authoring in `SKILL.md`. Read it once you know nothing installed and nothing in
either catalogue fits, and you are writing a new Skill.

The binding constraints — frontmatter fields, section order, the audit-then-confirm discipline and
the security rubric — are in `SKILL.md`. This file is how to get from a request to a draft worth
auditing.

## Define the contract first

Before drafting a line of prose, write down five things. If you cannot, the request is not yet a
Skill — ask the operator, or reach for a different forge.

| Part | Question it answers |
| --- | --- |
| Inputs | What must be true or supplied before this starts? |
| Actions | Which Tools get called, in what order? |
| Output | What durable artifact or answer exists at the end? |
| Errors | What goes wrong routinely, and what should happen then? |
| Finish condition | How does a reader check it worked, without asking you? |

A Skill with no checkable finish condition is a description, not a procedure. Rewrite the request
until one exists.

## Scope it to one task

One Skill, one repeatable task. Two tasks that merely share a domain are two Skills — a combined
one loads twice the instruction for half the relevance, and neither half gets maintained.

Signs the scope is wrong:

- The `description` needs "and" to stay honest.
- The procedure branches on what kind of request came in.
- Half the `tools` list is unused on any single run.

## Borrow structure from near-misses

Read the closest thing you found while searching, with `skill` and `mode: "inspect"` so it does not
replace this forge as your active Skill.

Take its section order, the shape of its pitfalls list and the phrasing of its verification
checklist. Do not take its content — a near-miss is near because its content is wrong for you.

## Draft the body

Follow the section order in `SKILL.md`. Beyond that:

- **Write for an Agent mid-Turn**, not for a person reading a manual. Short imperative sentences.
  No preamble, no motivation section, no history.
- **Name exact Tools and exact arguments.** "Call `skill_update` with `old_string` and
  `new_string`" beats "edit the Skill".
- **Put the constraint next to the step it constrains**, not in a rules section at the end. An
  Agent acts on step 4 without reading step 9.
- **State the negative cases.** What not to do is often the whole value; most failures are an Agent
  doing something plausible that the author knew was wrong.
- **Prefer a table to a paragraph** when the content is a set of parallel choices.

## Keep it small

Aim for roughly 100 lines. The body is loaded in full every Turn the Skill is active, so every line
competes with the Turn's actual work for attention.

When it grows past that, split rather than trim:

- Keep in the body anything the Agent must know **before** deciding what to do — rules, limits,
  the routing choice, the security bar.
- Move to `references/` anything it needs **after** deciding — worked steps, thresholds, examples,
  long tables.
- Point at each reference from the body, with the exact `skill` call that loads it.

A reference file ships with the package and is read with `skill`, `name`, and `file`. It is not
loaded automatically, so a reference nothing points to is a reference nothing reads.

## `tools` is a grant, not a wish list

The `tools` list is what the Skill may reach for while active. List exactly what the procedure
calls — no more, because an unused entry widens reach for nothing, and no fewer, because a missing
one fails mid-run.

A Skill with no `tools` field falls back to the full catalogue, and an empty `tools: []` is read the
same way — the runtime only builds a scope from a non-empty list. There is therefore no way to
grant nothing, so omitting the field is the widest grant available, never the safest. Always list
the Tools the procedure calls.

If the procedure fetches anything over the network, declare `allowedDomains` with exact hosts. No
wildcards, no URLs, no paths — a bare host such as `raw.githubusercontent.com`. Without it the
fetch is refused at dispatch, however correct the prose looks.

## Then audit and confirm

Call `skill_create` with `name`, `body` and `frontmatter`. It runs SkillAudit and returns a report
plus a `confirm` token, and writes nothing.

Show the operator the risk rating and every finding, then call `skill_create` again with the name
and that token alone. Never resend the body — repeating it would write text nobody audited.

Read the result back with `skill` and `mode: "inspect"` before you say it exists.
