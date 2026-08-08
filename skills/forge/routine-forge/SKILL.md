---
name: routine-forge
description: "Forge a Routine: design triggers, States, retries, Approvals, and hooks."
category: forge
tools:
  [
    routine_forge,
    routine_picker,
    trigger_routine,
    agent_list,
    agent_get,
    record_search,
    record_get,
    send_slack_message,
    present,
    request_input,
  ]
---
# Routine Forge Workflow

Guides authoring or editing one **Routine** — a scheduled/triggered automation that runs a
deterministic sequence of States (CNCF Serverless Workflow 0.8 subset + `x-` extensions). A Routine
lives at `soul/routines/<slug>/routine.yaml` (+ optional `hooks.ts`). The Chat harness owns the
whole session; this Skill reports its outcome directly.

{{FORGE_EXECUTION_CONTRACT}}

## Decide first: Routine, Agent, or Skill?

- **Routine** — a repeatable, mostly deterministic pipeline on a Trigger ("every morning at 9, tag
  overdue tickets and email a digest"; "when a lead is created, score it and notify sales"; "every
  2 minutes post a joke to Slack"). A schedule/event that produces generated or free-form *content*
  (a joke, a quote, a summary) is still a Routine — one State calls `agent:<agentName>` (Step 3) to
  generate the content, then a later State delivers it. Needing generated content on a Trigger is
  NOT by itself a reason to switch to Agent.
- Switch to **Agent** (`agent-forge`) only when there is no Trigger/schedule at all — the user wants
  a standing persona they'll talk to ad hoc. Switch to **Skill** (`skill-forge`) only for a single
  stateless instruction an Agent loads on demand. If the request names a cadence or event ("every
  X", "when Y happens", "at TIME"), stay in Routine — do not stop and switch.

## V1 surface

- **States:** `operation` (call Tools/Agents/hooks), `switch` (branch), `foreach` (iterate,
  cap 1000), `sleep` (ISO-8601 duration), `inject` (merge literal data). Deferred: `parallel`,
  `event` State, child Routine (`subFlowRef`).
- **Triggers (`x-triggers`, ≥1):** `manual`, `cron` (`schedule` cron expression, optional
  `timezone`), `interval` (`everyMs`, `startAt` ISO instant it's anchored to — for plain "every N
  minutes/hours" use this, not a cron expression), `datetime` (`at` ISO instant, fires once),
  `webhook` (`secret_ref` → a Secret name), `event` (`event` ∈
  resource.created·resource.updated·conversation.created·conversation.completed·integration.event,
  optional `filter`), `agent`. `cron`/`interval`/`datetime` are dispatched automatically by the
  schedule dispatcher — no separate activation step. Deferred: `integration`.
- **Approval channels:** `ui` (always), `slack` (if the Slack Integration is present).
  `email`/`sms` are Schema-accepted but fall back to `ui`.

## Create Flow — interview one step at a time, recommend an answer for each

### Step 1 — Purpose & Trigger(s)

Establish the one-sentence purpose and what starts it. Pick Trigger type(s) and their config
(cron `schedule`, interval `everyMs`/`startAt`, datetime `at`, webhook `secret_ref`, event `event`
name + optional `filter`). Most Routines
have exactly one Trigger; declare `{ type: "manual" }` too if the user should be able to run it
by hand from the Routines UI.

### Step 2 — Inputs (`x-inputs`, optional)

If a manual/webhook/Agent Run needs parameters, declare `x-inputs` as a JSON Schema. It renders the
manual-Trigger form and validates webhook/Agent payloads. Inputs arrive at runtime as
`trigger.payload`.

### Step 3 — Functions

Every external call a State makes is a named entry in `functions[]` with `operation`:

- `tool:<toolName>` — a platform Tool. Common ones: `record_search`, `record_get`,
  `record_create`, `record_update`, `record_delete` (Record CRUD), `send_slack_message`
  (requires a Slack **channel** — name or ID). Only reference Tools you know exist; a bad name
  fails at runtime, not at write.
- `agent:<agentName>` — spawn a headless Agent Turn (pass its brief as an `arguments.task`
  string). `routine_forge` validates the name against the real Agent registry at write time (a
  bad name comes back as `validation_error`), so `agent_list` is only needed when you're unsure
  which Agent to name in the first place — don't call it as a routine pre-check.
- `hook:<fnName>` — a function you define in `hooks.ts` (Step 8) for pure in-Routine computation.

**Ask for every required argument the request didn't already give you** — never invent or guess
one (a Slack channel, a record id, an email address). If the user's ask names a delivery Tool but
leaves out its target (e.g. "send me a joke on Slack" with no channel), that's a Step 1/3 interview
question, not a default to assume: ask which channel before writing the definition.

### Step 4 — States & flow

Design the State machine. Rules the writer enforces:

- `start` names the first State. Each State is `operation|switch|foreach|sleep|inject` and either
  `transition`s to another State's name or sets `end: true`. State names match
  `^[A-Za-z][A-Za-z0-9]*$` (PascalCase, no spaces/hyphens). Every `transition`/condition target
  must be a real State name.
- **operation:** `actions: [{ functionRef: { refName, arguments? }, actionDataFilter?, retryRef? }]`.
  Store a call's result into Run data with `actionDataFilter: { toStateData: "someKey" }`
  (optionally transform first with `results: "${ result.foo }"`) so later States can read
  `context.someKey`.
- **switch:** `dataConditions: [{ condition: "<js>", transition|end }]` + optional
  `defaultCondition`. First truthy condition wins.
- **foreach:** `inputCollection: "<js yielding an array>"`, optional `iterationParam` (default
  `item`), and `actions` run per element. The element is in scope as that parameter.
- **sleep:** `duration: "PT5M"` (ISO-8601). **inject:** `data: { ... }` merged into `context`.

### Step 5 — Expressions (`${ ... }`)

Argument values, switch `condition`s, foreach `inputCollection`, and data filters are JavaScript
strings evaluated in an isolated sandbox (100ms, no host/network/filesystem). In scope: `context`
(accumulated Run data), `trigger.type` / `trigger.payload`, the foreach iteration parameter, and
`result` inside an `actionDataFilter.results`. Argument strings of the form `"${ <js> }"` are
evaluated; plain strings pass through literally.

### Step 6 — Errors & retries (optional)

- `retries: [{ name, maxAttempts, delay?: "PT2S", multiplier? }]`; reference from an action via
  `retryRef`. Exponential backoff when `multiplier` > 1.
- Per-State `onErrors: [{ errorRef: "<name>"|"*", transition?|end? }]` routes failures to a
  recovery State or a clean end. Retries win while attempts remain, then `onErrors`, else the Run
  fails.
- Optional per-State `timeouts: { stateExecTimeout: "PT30S" }`.

### Step 7 — Human Approval (optional)

Gate a State behind a person: on an `operation`/`foreach` State set
`x-autonomy-level: human_approval` and `x-approval-channel: ["ui"]` (add `"slack"` when Slack is
connected). The Run pauses in `waiting_approval` and resumes on the decision. Only valid on
operation/foreach States.

### Step 8 — Hooks (`hooks.ts`, optional)

For pure computation the States cannot express, pass a `hooks` string: a parenthesized object
literal, no import/export:
`({ beforeHook(ctx){}, afterHook(ctx){}, before<State>(ctx){}, after<State>(ctx){}, <fnName>(ctx, args){} })`.

- `beforeHook`/`afterHook` fire once around the whole Run; `before<State>`/`after<State>` around
  that State. Step-callable `<fnName>` functions are invoked by a function with
  `operation: "hook:<fnName>"` and receive `(ctx, args)` — the return value is stored like any
  action result.
- `ctx` provides `ctx.runId`, `ctx.slug`, `ctx.stateName`, `ctx.context` (Run data),
  `ctx.trigger`. Pure computation only — same **banned patterns** as Resource hooks: no
  `require`/`import`/`eval`/`Function`/`process`/`global`/`Buffer`/`fetch`/timers/microtasks,
  no network, no Node APIs.

### Step 9 — Validate, preview, write

1. Assemble the `definition` object (id = the slug, `version` e.g. "1.0", `start`, `states`,
   `functions?`, `retries?`, `x-triggers`, `x-inputs?`).
2. Preview it concisely (purpose, Trigger, the State flow as a short list) with `present` or
   plain text — do not dump raw YAML — and get Approval via `request_input`.
3. On Approval call `routine_forge` with `name` (the slug), `definition`, and `hooks?` (the
   object-literal source). It validates against the V1 meta-Schema, writes
   `routines/<slug>/routine.yaml` (+ `hooks.ts`), and commits — no Approval step (ROUT-V1-002).
4. **Iterate on errors:** `routine_forge` returns `validation_error` with a JSON-pointer path and
   message (including "deferred in V1" for post-V1 constructs, and "transition target … not found" /
   "function … not found" for broken refs). Fix the definition and retry — do not work around it.

### Step 10 — Smoke-test (recommended)

For a Routine with a `manual` Trigger, offer to run it once: on the user's OK call
`trigger_routine` with the slug (+ inputs matching `x-inputs`) and report the Run outcome. Warn
first if the Routine performs real writes (`record_create`/`update`/`delete`), and skip the
test Run if the user prefers. Otherwise point them to the Routines UI to run/monitor it.

### Step 11 — Report

Confirm in one sentence (slug + Trigger + State count + whether it has hooks). Do not call
`complete_task` — the master flow owns session completion.

## Edit Flow

Read the existing Routine (via the Routines UI / prior forge), interview the change, describe the
diff in plain language, then call `routine_forge` again with the same `name` and the full updated
`definition` (it overwrites). Re-smoke-test if the Trigger/flow changed.

## Error handling

Recoverable (bad ref, Schema violation, user changes mind): fix and retry. A hard dead end
(repeated validation failure, a construct that is genuinely deferred in V1): stop and report the
specific error.
