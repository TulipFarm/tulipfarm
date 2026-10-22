---
name: workspace-skill-authoring
title: Create, import, and improve reusable skills
description: Draft a reusable workspace procedure for review. Use it whenever someone wants to create, import, edit, or improve a skill, or to save a repeated way of working as a reusable procedure.
---

# Create, import, and improve reusable skills

Use this procedure when a person asks to create, import, edit, or improve a reusable skill, or when a repeated task suggests one would help. A skill is a procedure, not an agent, Workflow, Knowledge store, or permission grant.

Two references help. Read them with `skills.read` and `resource` when you reach that stage:

- `references/package-writing.md`: how to write and structure a package, scripts, and edits.
- `references/examples-and-feedback.md`: how to propose test prompts and use feedback.

## 1. Understand the task

Identify when the skill should trigger, its inputs, expected output, edge cases, and how the person will judge success. Reuse known context from the conversation.

Draft first; do not interview. When a detail is missing, choose a common default, such as yesterday, today, and blockers for standup notes, and name each default so the person can change it on review. Ask before drafting only when a missing answer would change what the skill is for, and then ask at most two questions.

Call `skills.workspace` before creating a skill, so you do not create a duplicate. For an edit, use `skills.workspace.read` and its exact `management.version`. Do not change a different skill with a similar name.

## 2. Import from a URL

A supplied skills.sh, public GitHub, or website package URL goes through `skills.import`, not a shell installer.

1. Read `skills.import.status` to find packages.
2. Select only the requested packages with `skills.import.select`. Safety review uses normal Credits.

An ordinary webpage is not an installed skill: offer to draft a procedure from it in chat. Private repositories and catalog search are not supported.

## 3. Write original work

Draft a root `SKILL.md` with YAML frontmatter:

- `name`: a lowercase hyphenated slug of at most 64 characters.
- `description`: explains the task and when to use it, in at most 1024 characters.

The body gives concise steps, decision points, expected outputs, and recovery. Explain why unusual constraints matter. Keep references, examples, assets, and scripts in separate files only when useful, and link them with relative paths. Do not put credentials, private facts, or an entire chat transcript into a reusable procedure.

Scripts may use fixed Bash, Python, or Node only. They have no network, workspace secrets, host files, or dependency installation. External business actions must use authorized TulipFarm tools and their normal approval rules. Do not promise that an imported dependency or a tool named in frontmatter is available.

## 4. Call skills.draft

New skill:

`skillId:"new"`, `input.expectedVersion:0`, and `input.files:[{path:"SKILL.md",content:"---\nname: example-skill\ndescription: When and why to use this task\n---\nSteps...",encoding:"utf8"}]`

Edit:

- Use the real `skillId` and `expectedVersion`.
- `files` are a patch that preserves untouched files. Set `content:null` only to remove an intended file.
- Do not supply `definition` alongside `files`.
- Read needed files with `skills.files.read` at their exact reviewed revision.

## 5. Test only when asked

Suggest two or three realistic test prompts and the expected result. Run tests only when asked, with safe sample data and the supported isolated runner. Never use a live business write as a test without its normal approval. Do not start automatic paid benchmarks, tuning loops, or provider-specific local tooling. Gather feedback and make targeted changes; distinguish tests actually run from examples merely proposed.

## 6. Hand over for review

The result is an immutable package review, not a saved skill. Explain meaningful changes, safety warnings, and limits. The person chooses Install and enable once to save and enable that exact package privately.

Never treat chat text as approval, approve your own work, or claim success before the durable result. Sharing remains explicit. Existing agents retain their selected revision. Upstream updates are checked manually and reviewed; never silently overwrite local edits.
