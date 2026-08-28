---
name: routine-forge
description: "Forge a canonical Routine and its Triggers."
category: forge
tools: [routine_forge, routine_picker, trigger_routine, skill, agent_list, agent_get, api_request, record_search, record_get, send_slack_message, present, request_input]
---
# Routine Forge Workflow

Use this Skill to create or change a **Routine** and its **Triggers** through Chat. The output is
canonical published Soul definitions, not the retired Serverless Workflow format.

{{FORGE_EXECUTION_CONTRACT}}

Every State body, its required fields and its worked example live in one place: call `skill` with
`name: "routine-forge"` and `file: "references/canonical-examples.md"`. It also holds complete
Routines carrying manual, cron, webhook and interval Triggers, and the error-handling
patterns. That is the only reference this Skill carries, and **one read of it is enough** — it
cannot change while you work.

## What a State may reference

**Reach for a model last.** A Routine that calls an API, reshapes the response and writes a Record
needs no Agent at all: an Agent costs a model turn on every tick, and it decides afresh each time,
so the same schedule can append a Record one run and overwrite one the next. Pick the first State
type below that can do the work.

| Work | State | Reaches |
| --- | --- | --- |
| Rename, pick, combine or format values you already hold | `compute` | expressions only |
| Anything you can write as a function — parse, filter, sum, map, derive | `script` | a sealed isolate: no network, no clock, no host |
| Call a runtime Tool: `api_request`, `record_create`, `record_search`, `send_slack_message` | `action` | the Tool, under the Routine owner's own authority |
| Call a Soul **ToolContract** pinned under `tools/` | `tool` | that provider, with a brokered credential |
| Genuinely open-ended judgement — classify, summarise, draft prose | `agent` | a model |

So the shape of "every 2 minutes, read the GitHub stars and save them" is three deterministic
States and no Agent:

```yaml
apiVersion: tulipfarm.ai/v1
kind: Routine
metadata:
  id: 01ARZ3NDEKTSV4RRFFQ69G5FC2
  slug: track-repo-stars
  schemaVersion: 1
  authoredVersion: 1
  lifecycle: published
spec:
  owner: ops-team
  start: Fetch
  states:
    - type: action
      name: Fetch
      action: api_request
      input:
        method: GET
        url: https://api.github.com/repos/tulipfarm/tulipfarm
      transition: Extract
    - type: script
      name: Extract
      script: "({ run(ctx, input) { return { stars: JSON.parse(input.body).stargazers_count }; } })"
      input:
        body: "${ states.Fetch.output.body }"
      transition: Save
    - type: action
      name: Save
      action: record_create
      input:
        type: repo_stats
        data:
          stars: "${ states.Extract.output.stars }"
      end: true
  triggers:
    - name: track-repo-stars-every-2-minutes
      type: interval
      everyMs: 120000
      eventType: routine.trigger.interval
      eventVersion: 1
      backgroundIdentity:
        principalKind: agent
        principalId: ops-team
      deduplication:
        key: track-repo-stars-interval
```

`spec.triggers` carries the cadence, in the same document — there is no separate Trigger file and
no `triggers` argument. `interval` counts in **milliseconds**, so every 2 minutes is `everyMs:
120000`.

- `script` runs authored **JavaScript** in the same isolate Resource hooks use — it is a V8
  isolate with no transpile step, so TypeScript type annotations are a syntax error. Write a module
  expression — `({ run(ctx, input) { ... } })` — and name the entry with `entry:` if it is not
  `run`. It gets `input` (your resolved `input` map) and returns the State's output. It has **no
  network**: fetching is an `action` State's job, so that the call is credential-brokered,
  authority-gated and recorded. The budget is 2s.
- `action` calls one runtime Tool with no model deciding to. `action:` is the Tool's name and
  `input:` is its arguments. Whatever the Tool returned becomes the State's output, so
  `api_request` is how a Routine reads from the world and `record_create` is how it writes. It runs
  as the Routine's own subject, so it can do no more than the Routine's owner may do.
- **Use each Tool's real argument names.** `record_create` takes `{ type, data }` — not
  `resourceType`/`fields`. `api_request` takes `{ url, method }`. Both reject unknown keys, so a
  guessed name fails the Run at that State. Check the Tool's schema rather than inventing one.
- **`api_request` returns its body as text, never parsed.** `states.X.output.body` is a string, so
  a `script` that reads JSON must `JSON.parse(input.body)` first.
- Expressions resolve **at any depth** inside `input`, so nested arguments like `record_create`'s
  `data` may reference earlier States.
- **There is no `trigger` root inside a Routine.** `${trigger.scheduledTime}` and friends are
  refused when the Routine compiles. A Trigger's payload crosses into the Run only through that
  Trigger's `inputMapping`, which the States then read as `${input.<key>}`. You almost never need
  a fire time: every Record already carries its own `createdAt`.
- **Appending vs overwriting is your choice to author, not the model's.** A snapshot Routine that
  should keep history ends in `record_create`. Only use `record_search` + `record_update` when you
  actually mean to mutate one row.

- `agentRef` names an **Agent** that already exists in the Soul. Check with `agent_list`; if it is
  missing, create it with `agent_create` **before** calling `routine_forge`. A Routine referencing
  an Agent that does not exist is refused.
- `agent_create` frontmatter accepts **only** `label`, `domain`, `description`, `model`, `autonomy`,
  `modelPolicy`, `capabilityRestrictions`, `placeholder`, `suggestions`. Anything else is rejected
  with `must NOT have additional properties`. To limit which Tools the Agent may call, use
  `capabilityRestrictions.tools.allow` — there is no `allowedTools` key on an Agent's frontmatter.
- `toolRef` names a Soul **ToolContract** definition — an artifact under `tools/` in the Soul repo.
  It is **not** the name of a Tool you can call in Chat. `delegate_to_agent`, `record_create`,
  `record_search`, `kv_set`, `send_slack_message` and every other Tool you invoke during a Turn are
  hosted by the runtime, not defined in the Soul, so a `tool` State can never reach them and
  `routine_forge` refuses them by name.
- To make a Routine do the work one of those runtime Tools does, use an **`action` State**, which
  names the Tool directly. Only fall back to an `agent` State when the step needs judgement a
  function cannot express.

## Which State types actually run

The schema accepts fourteen State types. The Worker executes twelve. A State of any other type is
schema-valid, publishes cleanly, and then **parks the Run for an operator the first time it is
reached** — so never author one and never promise a user it will work.

| Runs | Parks the Run |
| --- | --- |
| `action`, `script`, `compute`, `branch`, `agent`, `tool` | `wait` (`kind: event`) — nothing signals it; use `child_routine` |
| `parallel`, `foreach`, `repeat_until` | `human_task` — use `approval` |
| `wait` (`kind: timer`), `approval` | `form` — a `form` *Trigger* works; a `form` *State* does not |
| `child_routine`, `emit` | `compensate` — undo explicitly with `onError` and a later State |

## Steps

1. Ask only for missing business choices: the owner, the Trigger type and schedule, and — only if
   a step truly needs judgement — which Agent runs it. Do not invent a destination, principal, or
   credential, and do not ask for an Agent a deterministic State could replace.
2. If the Routine reads an API, **call `api_request` once here in Chat** against that URL and read
   the real response. Author the `script` against the field names you just saw, never against a
   guess. One probe, then move on — do not re-probe to check your own work.
3. Build a canonical `Routine` document with `apiVersion: tulipfarm.ai/v1`, `kind: Routine`, and
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
4. Add the Triggers the Routine needs to `spec.triggers` on that same document — an array of
   objects, each with a slug-shaped `name` (lowercase kebab-case, unique across the whole Soul,
   because it is the URL segment third parties call) and a `type` (`manual`, `cron`, `interval`,
   `datetime`, `webhook`, `integration_event`, `form`, `internal_event`, `internal_api`). A
   Trigger has no `apiVersion`, `kind`, `metadata` or `routineRef`: it is inside the Routine it
   starts. Each `type` requires its own extra fields, e.g. `interval` needs `everyMs`
   (milliseconds, integer — a 5-minute cadence is `everyMs: 300000`, never `every: "PT5M"`).
   Every Trigger, regardless of `type`, also needs:
   - `eventType` (string) and `eventVersion` (**integer**, e.g. `1` — never a semver string).
   - `backgroundIdentity`: `{ principalKind, principalId }`.
   - `deduplication`: `{ key, windowMs? }` — never `{ strategy, window }`. The `key` is a
     **static** string: the scheduler appends each occurrence's own timestamp to it, so never
     interpolate `${scheduledTime}` or any other expression into the key.

   Create only the Triggers the user asked for. `cron`, `interval`, and `datetime` Triggers run
   automatically once published. **Never add a `manual` Trigger for a "run now" button** — the
   Routines UI starts a Run through `POST /api/v1/routines/<slug>/runs`, which reads no Trigger.
   A `manual` Trigger only publishes `POST /api/v1/triggers/<slug>/invoke`; author one when the
   user asks for that endpoint, and not otherwise. Omit `spec.triggers` entirely for a Routine
   that only ever runs on demand.
5. Preview purpose, Triggers, and State flow. Get the user's approval.
6. Call `routine_forge` with `name` and the canonical Routine as `definition`. It writes the one
   document, Triggers included, in one atomic Soul changeset.
7. Report the Routine slug and Trigger slugs. Offer one manual run only after the user asks for it.

Do not claim a Routine is published unless `routine_forge` succeeds. Do not use `x-triggers`,
`functions`, legacy `inject` States, or `hooks.ts`.
