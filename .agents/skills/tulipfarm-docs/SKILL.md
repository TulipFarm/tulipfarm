---
name: tulipfarm-docs
description: Write and maintain TulipFarm's public documentation in apps/docs. Use when adding, rewriting, splitting, merging, or reviewing a docs page; choosing where a page belongs; naming a slug; fixing docs voice, terminology, headings, or MDX components; or documenting a new feature, integration, setting, or environment variable.
---

# TulipFarm Docs

Public docs are read by people who are not engineers. A cafe owner and a platform engineer both
land here. Write for the one who has never seen a terminal, and the engineer still gets what they
came for.

## Workflow

1. Read `apps/docs/AGENTS.md`, then `metadata/terminologies.md`. Both are binding.
   Restructuring, renaming or dropping a guard? Read
   [references/decisions.md](references/decisions.md) first — it records what was already tried.
2. **Place the page before writing it.** Pick its track and its Diátaxis quadrant using
   [references/docs-guide.md](references/docs-guide.md) §1–§3. A page with no clear track is a
   page with no reader.
3. Apply the inclusion bar (§4) before adding anything: document it if a user or operator *can*
   set it **and** *should*. Setup earns a page; configuration earns a row.
4. **Verify every factual claim against code before writing it** (§7). Tool names, env vars,
   ports, counts, token prefixes and model behaviour are all things the docs have gotten wrong.
5. Write in the mode its track demands (§3) — prompt-first, screen-first, or terminal-first.
6. Check the draft against [references/voice.md](references/voice.md). Define every product term
   at its first use on that page; a link is not a definition.
7. Use only the surviving MDX components (§5), each under a meaningful `##`.
8. Adding a page under `using-tulipfarm/`? Give it a `tf-page` annotation (§8). The suite fails
   without one.
9. Set frontmatter `title` and `description` (§6), then run the checks below.

## Guardrails

- **No page under `using-tulipfarm/` may require admin access.** Check the capability against
  `apps/api/src/identity/roles.ts` — `ADMIN_ONLY_SURFACES` versus `MEMBER_ALLOWED_SURFACES`.
- Never name the reader. No "if you are an admin", no "for business owners". The `/docs` chooser
  sorts people; prose does not.
- Never tell a reader to hand-edit the Soul — no `mkdir`, `cat > schema.yml`, git commands or
  restarts. If the product path cannot do it, that is a product gap, not a docs workaround.
- Never retype machine-readable truth by hand. A hand-typed catalog of tools, routes or fields
  drifts and then lies; generate it or explain the pattern instead.
- Never document unshipped features. `forms`, routine authoring, memory scopes and sandbox
  backend selection are all off-limits.
- One page, one quadrant. A tutorial that turns into reference halfway serves neither reader.
- Never reuse a product mode (**Build**, **Operate**, Chat, Farm, Knowledge, Settings) or a
  canonical noun (Run, Soul, Agent, Skill, Routine, Record, Turn, Surface) as documentation
  structure — a section named like a product word will be read as one.
- Never write the site domain literally; use `{{SITE_URL}}` or import `SITE_URL`.
- Do not add MDX components. Six exist and each has a job (§5).
- Do not add product screenshots. No refresh process owns them, and they rot faster than prose.

## Completion Check

- `pnpm --filter @tulipfarm/docs build` passes — the only check that exercises the remark plugins
  end to end.
- `pnpm docs:test` passes. The docs guards live at the repo root because `apps/docs` has no test
  runner of its own; CI runs them in the `docs-build` job.
- Every internal link resolves and every anchor matches a real heading.
- Every product term on the page is defined at first use.
- The page reads correctly at 390px and 1440px if it uses `Steps`, `Cards`, or wide tables.
