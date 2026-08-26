# Maintaining a Skill

The long form of maintenance in `SKILL.md`. Read it when a Skill already exists and needs to
change — a wrong command, a missing pitfall, a stale limit, or a full rewrite.

The audit-then-confirm discipline and the security rubric are in `SKILL.md` and apply here exactly
as they do to a new Skill: an edit is audited before it is written.

## Read before you patch

Call `skill` with `name: "<the skill>"` and `mode: "inspect"`. Plain `skill` **adopts** the Skill
and replaces this forge as your active Skill, which ends the maintenance job mid-step.

Inspect mode returns the body as data, with provenance, so you can copy an exact `old_string` out
of it. Do not patch against remembered text; whitespace and wording you half-recall will not match.

## Pick the smallest edit that works

| Situation | Call | Why |
| --- | --- | --- |
| One wrong line, command, or limit | `skill_update` + `old_string` / `new_string` | Smallest diff, clearest audit |
| The same wrong text in several places | Add `replace_all: true` | One call instead of several fragile ones |
| Text that should simply go | `new_string: ""` | Valid, as long as the body stays non-empty and coherent |
| The procedure itself is wrong | `skill_update` + complete `body` | Only when a patch would touch most of the file |
| Frontmatter is wrong | `skill_update` + complete `frontmatter` | It replaces, so send every field you want kept |

Default to the first row. A complete `body` for a one-line correction throws away the parts of the
Skill someone else got right, and makes the audit review text that did not change.

## Make `old_string` unique

Without `replace_all`, the match must be unique across the body. When it is not, do not shorten the
string — extend it. Add the line above and the line below until only one place matches.

If a string is genuinely repeated and every occurrence should change, that is what `replace_all` is
for. If only some should change, extend each match instead; there is no positional selector.

## Frontmatter replaces, it does not merge

`frontmatter` on `skill_update` is the complete new frontmatter. A field you omit is a field you
deleted — including `tools` and `allowedDomains`, whose loss silently narrows what the Skill can
reach and turns a working procedure into one that fails at dispatch.

Read the current frontmatter with `mode: "inspect"` first, then send it back whole with your change
applied. Omit `frontmatter` entirely when only the body is changing.

## Bundled Skills

A bundled Skill ships with the product and is read-only in place. `skill_update` handles this for
you: the first write materialises a Soul copy that overrides the bundled one. Nothing extra to do.

Say what that means, though, because it is permanent. Once a bundled Skill is edited, startup stops
refreshing it from the shipped image, so it no longer picks up product updates to that Skill. Tell
the operator that before the confirming call, not after.

## Tokens are single-use

The `confirm` token from an audit is spent by the write it authorises, and it expires. A second
write needs a second audit.

If a token is rejected, do not retry with the same one and do not go looking for another. Re-run
`skill_update` without `confirm` to get a fresh report, show it, and confirm again — the operator
is approving the current bytes, not the previous ones.

One narrow exception exists in the Tool's own reply: an edit that does not change what SkillAudit
reads returns a token with no new report. Present that as what it is — an unchanged risk picture —
rather than as a clean audit you did not run.

## Verify the durable result

Read the Skill back with `skill` and `mode: "inspect"` and check the change is actually in the body.

A tool result that returned successfully is evidence the write was accepted, not evidence it said
what you meant. This is the step that catches a patch that matched the wrong occurrence.
