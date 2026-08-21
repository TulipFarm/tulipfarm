---
name: routine-forge
description: "Forge a canonical Routine and its Triggers."
category: forge
tools: [routine_forge, routine_picker, trigger_routine, agent_list, agent_get, record_search, record_get, send_slack_message, present, request_input]
---
# Routine Forge Workflow

Use this Skill to create or change a **Routine** and its **Triggers** through Chat. The output is
canonical published Soul definitions, not the retired Serverless Workflow format.

{{FORGE_EXECUTION_CONTRACT}}

1. Ask only for missing business choices: the owner, the Trigger type and schedule, and any Tool
   or Agent reference. Do not invent a destination, principal, or credential.
2. Build a canonical `Routine` document with `apiVersion: tulipfarm.ai/v1`, `kind: Routine`, and
   `metadata` with exactly these keys — no others, the schema rejects additional properties:
   - `id`: a fresh UUID or ULID (`8f14e...` / `01ARZ3...`), never the routine slug or a made-up
     string.
   - `slug`: lowercase kebab-case, matching the tool's `name` argument.
   - `schemaVersion: 1`, `authoredVersion` (integer, starts at `1`), `lifecycle: published`.
   Its `spec` needs `owner` and one or more canonical States. Every State key — `start`, each
   State's own `name`, and every `transition`/`branches`/`body`/`forState` reference to another
   State — must match `^[A-Za-z][A-Za-z0-9_]*$`: letters, digits, underscore only, **no hyphens**.
   Use PascalCase or snake_case (e.g. `ReadIssue`, `send_reply`), never the hyphenated style used
   for the Routine's own `slug`/`name`.
3. Build one or more canonical `Trigger` documents. Each uses the same `metadata` rules as step 2
   (fresh `id`, matching `slug`, `lifecycle: published`); its `spec.routineRef` must use the
   Routine slug and authored version. Every Trigger needs `backgroundIdentity`, `deduplication`,
   `eventType`, and `eventVersion`. Add a `manual` Trigger when the user needs a Routines UI entry
   point. `cron`, `interval`, and `datetime` Triggers run automatically after publication.
4. Preview purpose, Triggers, and State flow. Get the user's approval.
5. Call `routine_forge` with `name`, the canonical Routine as `definition`, and all canonical
   Trigger documents as `triggers`. It writes them in one atomic Soul changeset.
6. Report the Routine slug and Trigger slugs. Offer one manual run only after the user asks for it.

Do not claim a Routine is published unless `routine_forge` succeeds. Do not use `x-triggers`,
`functions`, legacy `inject` States, or `hooks.ts`.
