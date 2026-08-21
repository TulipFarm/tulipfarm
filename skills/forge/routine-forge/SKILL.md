---
name: routine-forge
description: "Forge a canonical Routine and its Triggers."
category: forge
tools: [routine_forge, routine_picker, trigger_routine, load_skill_reference, agent_list, agent_get, record_search, record_get, send_slack_message, present, request_input]
---
# Routine Forge Workflow

Use this Skill to create or change a **Routine** and its **Triggers** through Chat. The output is
canonical published Soul definitions, not the retired Serverless Workflow format.

{{FORGE_EXECUTION_CONTRACT}}

For complete schema templates, Cron/interval/webhook trigger examples, and State patterns, call
`load_skill_reference` with `skill: "routine-forge"` and `reference: "examples.md"` (or `"canonical-examples.md"`).

1. Ask only for missing business choices: the owner, the Trigger type and schedule, and any Tool
   or Agent reference. Do not invent a destination, principal, or credential.
2. Build a canonical `Routine` document with `apiVersion: tulipfarm.ai/v1`, `kind: Routine`, and
   `metadata` with exactly these keys — no others, the schema rejects additional properties:
   - `id`: a fresh UUID or ULID (`8f14e...` / `01ARZ3...`), **never** the routine slug or a
     made-up string.
   - `slug`: lowercase kebab-case, matching the tool's `name` argument.
   - `schemaVersion`: integer `1`.
   - `authoredVersion`: **integer**, starts at `1` — never a semver string like `"1.0.0"`.
   - `lifecycle`: `published`.
   Its `spec` needs `owner`, `start` (the name of the first State to run), and `states` — a **JSON
   array** of State objects (`[{ name: "...", type: "...", ... }]`), never a map/object keyed by name.
   Every State key — `start`, each State's own `name`, and every `transition`/`branches`/`body`/`forState`
   reference to another State — must match `^[A-Za-z][A-Za-z0-9_]*$`: letters, digits, underscore only,
   **no hyphens**. Use PascalCase or snake_case (e.g. `ReadIssue`, `send_reply`), never the hyphenated
   style used for the Routine's own `slug`/`name`. An `agent` State's `agentRef` and a `tool` State's
   `toolRef` are always an **object** `{ name, version }` (both strings; `id` optional) — never a bare
   string like `"joke-bot"`.
3. Build one or more canonical `Trigger` documents. Each uses the same `metadata` rules as step 2
   (fresh `id`, matching `slug`, `lifecycle: published`). A Trigger is discriminated by
   `spec.type` (`manual`, `cron`, `interval`, `datetime`, `webhook`, `integration_event`, `form`,
   `internal_event`, `internal_api`) — each `type` requires its own extra fields, e.g. `interval`
   needs `everyMs` (milliseconds, integer — a 5-minute cadence is `everyMs: 300000`, never
   `every: "PT5M"`). Every Trigger, regardless of `type`, also needs:
   - `spec.routineRef`: `{ name, version }` — `name` is the Routine's `slug` and `version` is the
     Routine's `authoredVersion` **cast to a string** (e.g. `authoredVersion: 1` → `version:
     "1"`), never `{ slug, authoredVersion }`.
   - `spec.eventType` (string) and `spec.eventVersion` (**integer**, e.g. `1` — never a semver
     string).
   - `spec.backgroundIdentity`: `{ principalKind, principalId }`.
   - `spec.deduplication`: `{ key, windowMs? }` — never `{ strategy, window }`.
   Add a `manual` Trigger when the user needs a Routines UI entry point. `cron`, `interval`, and
   `datetime` Triggers run automatically after publication.

## Worked example — "post a joke every 5 minutes"

Routine (`spec.owner` is a placeholder; ask the user for the real owner):

```yaml
apiVersion: tulipfarm.ai/v1
kind: Routine
metadata:
  id: 01ARZ3NDEKTSV4RRFFQ69G5FAV
  slug: post-a-joke
  schemaVersion: 1
  authoredVersion: 1
  lifecycle: published
spec:
  owner: ops-team
  start: PostJoke
  states:
    - type: tool
      name: PostJoke
      toolRef:
        name: send_slack_message
        version: "1"
      action: send_message
      end: true
```

Trigger (fires every 5 minutes, references the Routine above at its authored version):

```yaml
apiVersion: tulipfarm.ai/v1
kind: Trigger
metadata:
  id: 01ARZ3NDEKTSV4RRFFQ69G5FAX
  slug: post-a-joke-every-5-minutes
  schemaVersion: 1
  authoredVersion: 1
  lifecycle: published
spec:
  type: interval
  everyMs: 300000
  routineRef:
    name: post-a-joke
    version: "1"
  eventType: routine.trigger.interval
  eventVersion: 1
  backgroundIdentity:
    principalKind: agent
    principalId: ops-team
  deduplication:
    key: post-a-joke-interval
```

4. Preview purpose, Triggers, and State flow. Get the user's approval.
5. Call `routine_forge` with `name`, the canonical Routine as `definition`, and all canonical
   Trigger documents as `triggers`. It writes them in one atomic Soul changeset.
6. Report the Routine slug and Trigger slugs. Offer one manual run only after the user asks for it.

Do not claim a Routine is published unless `routine_forge` succeeds. Do not use `x-triggers`,
`functions`, legacy `inject` States, or `hooks.ts`.
