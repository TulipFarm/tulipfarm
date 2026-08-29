# Routine & Trigger Canonical Examples

Every Routine and Trigger published to the Soul must conform to `apiVersion: tulipfarm.ai/v1`.

## General Rules & Constraints

- Routine and Trigger documents are separate canonical Soul definitions, committed together atomically via `routine_forge`.
- `metadata.id`: fresh UUID (`8f14e...` / `11111111-1111-4111-8111-111111111111`).
- `metadata.slug`: lowercase kebab-case (`^[a-z0-9]+(-[a-z0-9]+)*$`), matching the Routine or Trigger name.
- `metadata.schemaVersion`: `1`
- `metadata.authoredVersion`: `1` (integer, incremented when updating).
- `metadata.lifecycle`: `"published"`
- All State names (`start`, state `name`, `transition`, branch conditions `transition`, `body`, `forState`, etc.) must match `^[A-Za-z][A-Za-z0-9_]*$`: letters, digits, and underscores only (**no hyphens**). PascalCase or snake_case is standard.

### What a State may reference — read this before writing States

**Reach for a model last.** A Routine that calls an API, reshapes the response and writes a Record
needs no Agent at all: an Agent costs a model turn on every tick, and it decides afresh each time,
so the same schedule can append a Record one run and overwrite one the next. Pick the first State
type that can do the work:

| Work | State | Reaches |
| --- | --- | --- |
| Rename, pick, combine or format values you already hold | `compute` | expressions only |
| Anything you can write as a function — parse, filter, sum, map, derive | `script` | a sealed isolate: no network, no clock, no host |
| Call a runtime Tool: `api_request`, `record_create`, `record_search`, `send_slack_message` | `action` | the Tool, under the Routine owner's own authority |
| Call a Soul **ToolContract** pinned under `tools/` | `tool` | that provider, with a brokered credential |
| Genuinely open-ended judgement — classify, summarise, draft prose | `agent` | a model |

- `agentRef` must name an **Agent that already exists in the Soul**. Check with `agent_list`, and
  create it with `agent_create` first if it is missing. Prerequisites before dependants, always.
- `toolRef` must name a Soul **ToolContract** definition (an artifact under `tools/` in the Soul
  repo). It is **not** the name of a Tool you call during a Turn. `delegate_to_agent`,
  `record_create`, `record_search`, `kv_set`, `send_slack_message`, `github.issue.read` and every
  other runtime Tool are hosted by the instance, not defined in the Soul; a `tool` State cannot
  reach them and `routine_forge` refuses them by name. To have a Routine do what one of those
  Tools does, use an **`action` State**, which names the Tool directly — not an Agent holding it.
- `routineRef` on a `child_routine` State must name a **Routine that already exists in the Soul**,
  by its `slug` and its `authoredVersion` as a string. Forge the callee first.

---

## 1. Minimal Routine with Manual Trigger

### Routine Document

Triggers live in `spec.triggers` on the Routine itself — there is no separate Trigger document and
no `triggers` argument to `routine_forge`.

This Routine is on-demand only, so a `manual` Trigger is the right choice: it publishes
`POST /api/v1/triggers/daily-report-manual/invoke` for an external caller. It is **not** what
makes the Routines UI "run now" button work — that button posts to
`POST /api/v1/routines/<slug>/runs` and needs no Trigger. Never pair a scheduled Trigger with a
`manual` one unless the user asked for the REST endpoint, and omit `spec.triggers` entirely for a
Routine that only ever runs from that button.

```yaml
apiVersion: tulipfarm.ai/v1
kind: Routine
metadata:
  id: 11111111-1111-4111-8111-111111111111
  slug: daily-report
  displayName: Daily Report Generation
  schemaVersion: 1
  authoredVersion: 1
  lifecycle: published
spec:
  owner: operations
  start: RunReport
  states:
    - name: RunReport
      type: agent
      agentRef:
        name: report-writer
        version: "1"
      input:
        task: Search the report records and summarise today's numbers.
      end: true
  triggers:
    - name: daily-report-manual
      type: manual
      eventType: routine.manual
      eventVersion: 1
      backgroundIdentity:
        principalKind: service
        principalId: routine-runner
      deduplication:
        key: daily-report-manual
```

---

## 2. Scheduled Cron Routine with Branching & Approvals

### Routine Document
```yaml
apiVersion: tulipfarm.ai/v1
kind: Routine
metadata:
  id: 33333333-3333-4333-8333-333333333333
  slug: stale-ticket-sweep
  displayName: Stale Ticket Sweep
  schemaVersion: 1
  authoredVersion: 1
  lifecycle: published
spec:
  owner: support-ops
  start: EvaluateTickets
  states:
    - name: EvaluateTickets
      type: agent
      agentRef:
        name: support-triage
        version: "1"
      input:
        task: >-
          Search open tickets not updated in 7 days and decide whether to close them.
      output:
        type: object
        required: [shouldClose, ticketIds, reason]
        properties:
          shouldClose:
            type: boolean
          ticketIds:
            type: array
            items:
              type: string
          reason:
            type: string
      transition: RouteDecision

    - name: RouteDecision
      type: branch
      conditions:
        - condition: states.EvaluateTickets.output.shouldClose
          transition: RequestClosureApproval
      default:
        end: true

    - name: RequestClosureApproval
      type: approval
      approverRoles:
        - support-lead
        - admin
      transition: CloseStaleTickets

    - name: CloseStaleTickets
      type: agent
      agentRef:
        name: support-triage
        version: "1"
      input:
        task: Close these tickets with the given reason.
        ticketIds: "${states.EvaluateTickets.output.ticketIds}"
        reason: "${states.EvaluateTickets.output.reason}"
      end: true
```

### Its Triggers

Appended to the same document's `spec`, alongside `states`. The `deduplication.key` is a **static**
string — the scheduler appends each occurrence's own timestamp, so interpolating `${scheduledTime}`
only makes the key uninterpretable.

```yaml
  triggers:
    - name: stale-ticket-sweep-cron
      type: cron
      expression: "0 2 * * *"
      timezone: "UTC"
      eventType: routine.cron
      eventVersion: 1
      backgroundIdentity:
        principalKind: service
        principalId: routine-runner
      deduplication:
        key: stale-ticket-sweep
      schedule:
        missedRunPolicy: run_once
        overlapPolicy: skip
```

---

## 3. Webhook Triggered Automation

### Routine Document
```yaml
apiVersion: tulipfarm.ai/v1
kind: Routine
metadata:
  id: 55555555-5555-4555-8555-555555555555
  slug: webhook-issue-triage
  displayName: Webhook Issue Triage
  schemaVersion: 1
  authoredVersion: 1
  lifecycle: published
spec:
  owner: engineering
  start: AnalyzeIssue
  states:
    - name: AnalyzeIssue
      type: agent
      agentRef:
        name: issue-classifier
        version: "1"
      input:
        task: Read the issue and choose labels and a reply.
        repository: "${input.repository}"
        issueNumber: "${input.issueNumber}"
      output:
        type: object
        required: [labels, reply]
        properties:
          labels:
            type: array
            items:
              type: string
          reply:
            type: string
      transition: ApplyLabels

    - name: ApplyLabels
      type: agent
      agentRef:
        name: issue-classifier
        version: "1"
      input:
        task: Apply these labels to the issue.
        repository: "${input.repository}"
        issueNumber: "${input.issueNumber}"
        labels: "${states.AnalyzeIssue.output.labels}"
      end: true
```

### Its Trigger

The `name` is the `:trigger` segment of `/api/v1/hooks/:provider/:trigger`, the URL you register
with the provider, so it must be unique across the whole Soul — not merely within this Routine.

`inputMapping` is the **only** way payload reaches the Routine: it is an allowlist of the fields an
untrusted webhook body may cross into a Run, and the States then read them as `${input.<key>}`.
There is no `trigger` root inside a Routine — `${trigger.anything}` is refused when the Routine
compiles.

```yaml
  triggers:
    - name: github-issues-webhook
      type: webhook
      provider: github
      eventType: github.issues.opened
      eventVersion: 1
      inputMapping:
        repository: repository.full_name
        issueNumber: issue.number
      verification:
        method: hmac_sha256
        secretRef: secret://integrations/github/webhook-secret
        signatureHeader: X-Hub-Signature-256
      backgroundIdentity:
        principalKind: service
        principalId: routine-runner
      deduplication:
        key: github-issue
```

---

## 4. Interval Trigger Example

`everyMs` is **milliseconds**, so 15 minutes is `900000` — never `every: "PT15M"`.

```yaml
  triggers:
    - name: sync-every-15m
      type: interval
      everyMs: 900000
      eventType: routine.interval
      eventVersion: 1
      backgroundIdentity:
        principalKind: service
        principalId: routine-runner
      deduplication:
        key: daily-report-interval
      schedule:
        missedRunPolicy: skip
        overlapPolicy: skip
```

---

## 5. State Types Reference & Patterns

### `action`
Calls one runtime Tool directly, with no model deciding to. `action:` is the Tool's name and
`input:` is its arguments; whatever the Tool returned becomes the State's output. It runs as the
Routine's own subject, so it can do no more than the Routine's owner may do. This is how a Routine
reads from the world (`api_request`) and writes to it (`record_create`, `send_slack_message`) —
reach for an `agent` State only when the step needs judgement.

**Use each Tool's real argument names.** `record_create` takes `{ type, data }`, not
`resourceType`/`fields`; `api_request` takes `{ url, method }`. Both reject unknown keys, so a
guessed name fails the Run at that State. `api_request` returns its body as **text, never parsed** —
`states.<Name>.output.body` is a string.

Expressions resolve at any depth inside `input`, so nested arguments may reference earlier States.

```yaml
name: SaveStars
type: action
action: record_create
input:
  type: repo_stats
  data:
    stars: "${states.Extract.output.stars}"
end: true
```

**An expression may sit inside a longer string.** A value is not limited to being one whole
expression — text around it, and several expressions in one string, both interpolate:

```yaml
name: NotifySlack
type: action
action: send_slack_message
input:
  channel: C0BMFUD0HM5
  text: "TulipFarm stars: ${states.Extract.output.stars} (up ${states.Extract.output.delta} today)"
end: true
```

Four rules govern it:

- **A string that is *exactly* one expression keeps that expression's type.** `stars:
  "${states.Extract.output.stars}"` stays the **number** `42`, which is what `record_create` needs;
  `"Stars: ${states.Extract.output.stars}"` becomes the **string** `"Stars: 42"`. Never wrap a
  numeric or boolean argument in surrounding text unless you mean to send text.
- **Only scalars render.** A part that evaluates to `null`, a list or an object **fails the State**
  rather than writing `null` or `[object Object]` into the message. Guard a value that may be
  missing with `${ coalesce(states.X.output.name, 'unknown') }`.
- **Write `$${` for a literal `${`.** A `${ … }` you meant as plain text is otherwise compiled,
  and an unknown root fails the forge with `invalid_expression`.
- **Prefer interpolation over a `script` that only builds a sentence.** A `compute` or `action`
  State can format the message itself; do not spend an isolate on string concatenation.

**Appending vs overwriting is yours to author.** A snapshot Routine that should keep history ends
in `record_create`. Use `record_search` + `record_update` only when you actually mean to mutate one
existing row.

### `script`
Runs authored **JavaScript** in the same sealed V8 isolate Resource hooks use — parse, filter, sum,
map, derive. There is no transpile step, so **TypeScript type annotations are a syntax error**.
Write a module expression and name the entry with `entry:` if it is not `run`. It receives `input`
(your resolved `input` map) and returns the State's output. It has **no network**: fetching is an
`action` State's job, so the call stays credential-brokered, authority-gated and recorded. Budget
is 2s.

```yaml
name: Extract
type: script
script: "({ run(ctx, input) { return { stars: JSON.parse(input.body).stargazers_count }; } })"
input:
  body: "${states.Fetch.output.body}"
transition: SaveStars
```

### `tool`
Calls a **Soul ToolContract** — a definition under `tools/` in the Soul repo, named by its
`spec.toolId` and `spec.toolVersion`. Runtime Tool names (`send_slack_message`, `record_search`,
`delegate_to_agent`, …) are not ToolContracts and are refused here; use an `action` State for those.

```yaml
name: SendNotification
type: tool
toolRef:
  name: acme.notify.send      # a ToolContract the Soul actually defines
  version: "1"
action: send
destination: acme
input:
  channel: "#general"
  text: "Routine completed."
end: true
```

### `agent`
Delegates structured reasoning to an Agent:
```yaml
name: TriageStep
type: agent
agentRef:
  name: triage-agent
  version: "1"
input:
  summary: "${states.FetchStep.output}"
output:
  type: object
  required: [priority]
  properties:
    priority:
      type: string
      enum: [low, medium, high]
transition: NextStep
```

### `compute`
Derives values from expressions alone — no model, no Tool, no effect. `input` is required and
**is** the State's output, read later as `${states.<StateName>.output.<key>}`. This is how a
Routine shapes, renames and decides over its own data without an LLM in the loop.

Expressions read `input` (the Trigger's mapped input), `states`, `item`, and `loop`. They compare,
do arithmetic, and call `len`, `has`, `lower`, `upper`, `trim`, `contains`, `startsWith`,
`endsWith`, and `coalesce`. There is no `if`/ternary, and `&&`/`||` yield `true`/`false` rather
than one of their operands — to pick between two values, `branch` on the condition and let each arm
reach its own `compute` State. They cannot call a Tool, read a clock, or change anything: a
`compute` State that needs any of those is really an `action`, `tool` or `agent` State.

```yaml
apiVersion: tulipfarm.ai/v1
kind: Routine
metadata:
  id: 01ARZ3NDEKTSV4RRFFQ69G5FB0
  slug: triage-issue
  schemaVersion: 1
  authoredVersion: 1
  lifecycle: published
spec:
  owner: ops-team
  start: DeriveLabel
  states:
    - type: compute
      name: DeriveLabel
      input:
        isBug: "${ contains(lower(input.title), 'bug') }"
        issue: "${ input.issueNumber }"
      transition: Decide
    - type: branch
      name: Decide
      conditions:
        - condition: states.DeriveLabel.output.isBug
          transition: LabelBug
      default:
        transition: LabelQuestion
    - type: compute
      name: LabelBug
      input:
        label: need-triage
      end: true
    - type: compute
      name: LabelQuestion
      input:
        label: question
      end: true
```

### `child_routine`
Calls another published Routine. `routineRef` is an object `{ name, version }`, where `name` is
the callee's `slug` and `version` its `authoredVersion` as a string. The callee runs with the
authority it was published with, never a slice of the caller's.

`mode: wait` parks the caller and **requires** `deadlineMs`; `mode: detach` starts the callee and
continues at once, learning nothing of the outcome. Handle a failed callee with
`onError: [{ errorRef: child_failed, … }]`; a cancelled or expired one parks for an operator.
Call chains are depth-bounded and a call past the ceiling is refused.

```yaml
apiVersion: tulipfarm.ai/v1
kind: Routine
metadata:
  id: 01ARZ3NDEKTSV4RRFFQ69G5FB1
  slug: refresh-knowledge
  schemaVersion: 1
  authoredVersion: 1
  lifecycle: published
spec:
  owner: ops-team
  start: Reindex
  states:
    - type: child_routine
      name: Reindex
      routineRef: { name: reindex-knowledge, version: "3" }
      mode: wait
      deadlineMs: 600000
      input:
        source: "${ input.sourceSlug }"
      onError:
        - errorRef: child_failed
          transition: NotifyOwner
      end: true
    - type: compute
      name: NotifyOwner
      input:
        failedSource: "${ input.sourceSlug }"
      end: true
```

### `emit`
Announces an internal event and continues. Any published Trigger of type `internal_event` whose
`matchEventType`/`matchEventVersion` equal the announced pair starts its own Run. That Trigger's
`filter` sees the announced map as `trigger.payload`; to give it to the *Routine*, map the fields
you want through the Trigger's `inputMapping`, and the States read them as `${input.<key>}`.

`emit` never waits and never fails for want of a listener — if nothing matches, or two Triggers
match equally well, the State still succeeds. Event types starting `resource.` are reserved for
the instance's own Record mutations and are refused. Emission chains are depth-bounded the same
way call chains are.

```yaml
apiVersion: tulipfarm.ai/v1
kind: Routine
metadata:
  id: 01ARZ3NDEKTSV4RRFFQ69G5FB2
  slug: classify-ticket
  schemaVersion: 1
  authoredVersion: 1
  lifecycle: published
spec:
  owner: ops-team
  start: Classify
  states:
    - type: compute
      name: Classify
      input:
        label: "${ lower(trim(input.rawLabel)) }"
      transition: AnnounceTriaged
    - type: emit
      name: AnnounceTriaged
      event: { type: ticket.triaged, version: 1 }
      input:
        ticketId: "${ input.ticketId }"
        label: "${ states.Classify.output.label }"
      end: true
```

### `branch`
Routes conditionally based on prior state output:
```yaml
name: CheckPriority
type: branch
conditions:
  - condition: "states.TriageStep.output.priority == 'high'"
    transition: EscalateImmediately
  - condition: "states.TriageStep.output.priority == 'medium'"
    transition: StandardNotification
default:
  transition: LogLowPriority
```

### `approval`
Pauses for a person. `approverRoles` names **Roles, not people**. The item appears in Inbox, and in
Slack when Slack is connected. Approving resumes the Run; denying takes the State's failure path,
so give it an `onError` arm.

```yaml
apiVersion: tulipfarm.ai/v1
kind: Routine
metadata:
  id: 01ARZ3NDEKTSV4RRFFQ69G5FB4
  slug: gated-deploy
  schemaVersion: 1
  authoredVersion: 1
  lifecycle: published
spec:
  owner: ops-team
  start: ConfirmDeploy
  states:
    - type: approval
      name: ConfirmDeploy
      approverRoles: [ops-lead, admin]
      onError:
        - errorRef: "*"
          end: true
      transition: Deploy
    - type: compute
      name: Deploy
      input:
        deployed: "${ input.releaseTag }"
      end: true
```

### `wait`
A durable pause. Only `kind: timer` runs — `kind: event` publishes cleanly and then parks the Run
for an operator, because nothing signals it. Use a `child_routine` State when you need to wait on
other work.

```yaml
name: DelayOneHour
type: wait
waitFor:
  kind: timer
  durationMs: 3600000
transition: NextCheck
```

### `foreach`, `parallel`, `repeat_until`
All three composite States name a `body` (or `branches`) that is an ordinary State declared
elsewhere in `spec.states`. All three **require** their bounds — an unbounded loop or fan-out is
refused at forge time, not discovered at runtime. None of the three can be simulated, so a dry run
refuses them; test them on a real Run.

```yaml
apiVersion: tulipfarm.ai/v1
kind: Routine
metadata:
  id: 01ARZ3NDEKTSV4RRFFQ69G5FB3
  slug: process-batch
  schemaVersion: 1
  authoredVersion: 1
  lifecycle: published
spec:
  owner: ops-team
  start: FetchBoth
  states:
    - type: parallel
      name: FetchBoth
      branches: [FetchTickets, FetchCustomers]
      maxConcurrency: 2
      join: all
      transition: ProcessEach
    - type: compute
      name: FetchTickets
      input:
        tickets: "${ input.ticketIds }"
      end: true
    - type: compute
      name: FetchCustomers
      input:
        customers: "${ input.customerIds }"
      end: true
    - type: foreach
      name: ProcessEach
      items: input.ticketIds
      body: HandleOne
      maxItems: 100
      maxConcurrency: 5
      transition: PollUntilReady
    - type: compute
      name: HandleOne
      input:
        handled: "${ item }"
      end: true
    - type: repeat_until
      name: PollUntilReady
      condition: loop.iteration >= 3
      body: CheckStatus
      maxIterations: 20
      maxDurationMs: 600000
      transition: Summarize
    - type: compute
      name: CheckStatus
      input:
        ready: true
      end: true
    - type: compute
      name: Summarize
      input:
        finished: true
      end: true
```

Three rules that are easy to get wrong:

- **`items` and `condition` are bare expressions, not `${ … }` templates.** Only values inside an
  `input` map take the `${ … }` wrapper. `condition: states.Derive.output.isBug` is right;
  `condition: "${states.Derive.output.isBug} == true"` fails to compile.
- **A loop condition cannot read its own body.** The body runs *after* the loop State in the graph,
  so `states.<body>.output` is an `unreachable_reference`. Use `loop.iteration`, `loop.elapsedMs`,
  `input.*`, or the output of a State that genuinely ran earlier.
- Inside a `foreach` body the current element is `${item}` and `${loop}` carries the counters.
  `join` is `all` (default), `any`, or `quorum`.

### Error Handling & Retries
```yaml
name: ResilientStep
type: agent
agentRef:
  name: ticket-triage
  version: "1"
input:
  task: Search open tickets and triage them.
retry:
  maxAttempts: 3
  backoffMs: 1000
  multiplier: 2
onError:
  - errorRef: RateLimitError
    transition: DelayAndRetry
  - errorRef: "*"
    end: true
transition: NextState
```

---

## 6. How to Invoke `routine_forge`

Pass the routine `name`, the canonical Routine as `definition`, and all Triggers in the `triggers` array:

```json
{
  "name": "daily-report",
  "definition": {
    "apiVersion": "tulipfarm.ai/v1",
    "kind": "Routine",
    "metadata": {
      "id": "11111111-1111-4111-8111-111111111111",
      "slug": "daily-report",
      "displayName": "Daily Report",
      "schemaVersion": 1,
      "authoredVersion": 1,
      "lifecycle": "published"
    },
    "spec": {
      "owner": "operations",
      "start": "RunReport",
      "states": [
        {
          "name": "RunReport",
          "type": "agent",
          "agentRef": { "name": "report-writer", "version": "1" },
          "input": { "task": "Search the report records and summarise today's numbers." },
          "end": true
        }
      ]
    }
  },
  "triggers": [
    {
      "apiVersion": "tulipfarm.ai/v1",
      "kind": "Trigger",
      "metadata": {
        "id": "22222222-2222-4222-8222-222222222222",
        "slug": "daily-report-manual",
        "displayName": "Manual Trigger",
        "schemaVersion": 1,
        "authoredVersion": 1,
        "lifecycle": "published"
      },
      "spec": {
        "type": "manual",
        "routineRef": { "name": "daily-report", "version": "1" },
        "eventType": "routine.manual",
        "eventVersion": 1,
        "backgroundIdentity": {
          "principalKind": "service",
          "principalId": "routine-runner"
        },
        "deduplication": {
          "key": "daily-report-manual"
        }
      }
    }
  ]
}
```
