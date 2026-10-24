# Agents, tasks, and tools

Entry points inspected on 2 October 2026 at `937f21eb`. This package owns saved
agents, skills, private tasks, model calls, and the deterministic tool executor.
The worker composes those services into running workflows.

| Concern                             | Source                                                                                                                                                                              | Evidence                                                                    |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Saved definitions and authoring     | [`saved-service.ts`](src/saved-service.ts), [`authoring.ts`](src/authoring.ts)                                                                                                      | [Agents delivery](../../docs/agents-delivery.md)                            |
| Private task admission and history  | [`tasks.ts`](src/tasks.ts)                                                                                                                                                          | [Task journey](../../docs/agent-task-journey.md)                            |
| Multistep task execution            | [`task-runtime.ts`](src/task-runtime.ts), [`task-approvals.ts`](src/task-approvals.ts)                                                                                              | [Task runtime](../../docs/agent-task-runtime.md)                            |
| File and tool active-work time      | [`task-activity.ts`](src/task-activity.ts)                                                                                                                                          | [Lifetime ownership](../../docs/agent-task-runtime.md#active-work-lifetime) |
| Workspace procedures                | [`workspace-skills.ts`](src/workspace-skills.ts)                                                                                                                                    | [Skills delivery](../../docs/skills-ui-delivery.md)                         |
| Model tool contracts and invocation | [`tools.ts`](src/tools.ts), [`inference.ts`](src/inference.ts)                                                                                                                      | [Tool framework](../../docs/tools-framework-plan.md)                        |
| Chat plans and their scheduler      | [`plan-contracts.ts`](src/plan-contracts.ts), [`plans.ts`](src/plans.ts), [`plan-runtime.ts`](src/plan-runtime.ts), [worker composition](../../apps/worker/src/plan-composition.ts) | [Chat plans](#chat-plans)                                                   |
| Private chat runtime wiring         | [`conversation-activities.ts`](../../apps/worker/src/conversation-activities.ts)                                                                                                    | [Conversation delivery](../../docs/conversation-delivery-evidence.md)       |

Use the [verification guide](../../docs/verification.md) for runner prerequisites
and [current feature evidence](../../docs/features.md) for delivery limits.

## Chat-tool composition

Inspected on 11 October 2026. `createChatTools(runtime, options)` takes named
`ChatToolsOptions`; callers supply only the dependencies they use, such as
`{ knowledge }` or `{ google, slack }`. An omitted or `undefined` dependency stays
unavailable. `telemetryRuntime` defaults to `chat`.

Each tool call records `call_count`, `call_time` and a log line labelled by
`tool`, `runtime` and `outcome`: `success`, `waiting`, `blocked`, `error` (the
call threw or its task failed) or `result_error` (it returned a structured
failure the chat shows as failed, such as `knowledge-unavailable`, a failed
`web.fetch`, or a knowledge retrieval whose branches all failed or were
unavailable). `error`, `result_error` and `blocked` also count in
`cloud_tool_failures` and log `call_failed` with a bounded `error.code`; for
`result_error`, `error.type` repeats that code.

The worker's `meteredReply(runtime, options)` takes named `MeteredReplyOptions`.
Omitted or `undefined` `slack`, `mcp`, and `knowledge` settings retain their
environment-based defaults; supplied factories bypass those defaults.
`mcp: null` explicitly disables MCP. These defaults are resolved when the reply
is constructed, not on each turn. Other settings remain optional.

Tool selection, approval, source checks, credit admission, and cleanup still run
inside the existing modules. Configuration grants no authority. The worker keeps
per-call guarded storage and lazy provider construction; it does not share a
tool instance across guarded calls.

## Deterministic resource executor

`createAgentExecutor` executes validated, persisted calls through the resource domain used by HTTP. It is a deterministic executor. It does not select calls with a language model.

Model callers share a [stable system prompt and runtime reminder](../../docs/agent-prompts.md), grounded in [public harness source research](../../docs/agent-prompt-research.md).

## Persisted authority

An admin saves an immutable definition, configures current limits and team assignments, then activates an exact definition revision and scope. Saving another definition leaves existing activations and runs pinned.

A delegated run stores its initiating user and membership incarnation. A scheduled run stores an independently revocable admin-authorized schedule. The shared `@tulipfarm/access` policy intersects current caller authority, agent grants, limits, activation, and run scope on each operation. Scheduled work additionally uses current schedule authorization.

A schedule's action is either a table inspection or a saved prompt ([schedules](src/schedules.ts), [contract](src/schedule-contracts.ts)). A prompt schedule starts a private task owned by its sponsor, so the task runs with the sponsor's access intersected with the activation scope and appears only in the sponsor's task list. It runs at most hourly, uses the saved task limits, and starts the next task only after the previous one is completed, failed, or paused. A sponsor who loses access pauses the schedule. A refused start, such as the 1,000-task limit, skips that occurrence. Common migration `0008_agent_task_schedules.sql` links each task to its schedule. Saving an existing schedule with a new interval changes it in place, makes the saver its sponsor, and records an `agent.schedule.interval` audit event. A due run stays due; a later run moves to its last start plus the new interval, but never into the past. Common migration `0009_agent_schedule_interval_edit.sql` lets the runtime change the interval. Inspected 12 October 2026: the contract also supports five-field cron with an IANA time zone, retaining the hourly minimum for task prompts.

Agent creation now uses a [persisted setup coordinator](src/setup.ts) for shared
manual/chat review, save-only drafts and explicit activation. It stages Slack and
schedule intents without starting them. See the [approved experience](../../docs/plans/agent-builder-experience.md)
and [verification guide](../../docs/verification.md) for local proof and its limits.

The tool registry offers schema inspection and status, plus record listing, creation, update and deletion. Agents cannot change schemas. Schema changes go through reviewed resource proposals.

Task admission is capped at 1,000 active tasks per member: pending, waiting for clarification or approval, and paused tasks count; completed and failed history does not. Starting, reopening completed work, and retrying or pausing failed work use the same capacity check. A refused scheduled start is recorded as `agent.schedule.skip.<reason>` and shown only to its sponsor as the latest schedule result. The schedule remains enabled and tries again at the next occurrence.

## Chat plans

Added on 10 October 2026. A chat plan is a hierarchy of tasks with dependencies. Groups organize work, and dependency
edges decide what may start. `plan-contracts.ts` validates the graph and decides readiness. `plans.ts` stores plans in
workspace SQL (`0018_agent_plans.sql`, `0021_agent_plan_allowances.sql`). Each plan belongs to one chat and its starter.

`plan-runtime.ts` schedules work. Each `step` locks the plan, settles what workers reported, releases dependents, and
claims ready, assigned tasks. A plan runs at most three workers at once. A task waiting for an answer or approval
does not hold a worker slot. Each claim is an attempt with its own allowance: a fair share of the plan budget that has
not been spent or promised to open attempts. When no ready work can be funded and nothing is running, the plan pauses
for the budget. It also pauses when its starter loses membership or chat access.

- **Saved agents** start through the existing task admission as the starter, pinned to the latest live activation.
  The attempt ID is the start request ID, so a repeated step never starts a second task. The plan reads the task's
  status as the starter. Lost access fails the task. A task the starter can no longer invoke is blocked.
- **Specialists** are plan-scoped definitions that hold only read-only chat tools. They act as the starter and run
  through `inferSpecialist` in the worker's `runPlanSpecialist` activity. Each model step renews a 120-second lease
  and reserves credits on the attempt's own flow, within its allowance. A lost lease fails the attempt. The task
  retries with a new attempt, up to three in total. A stale attempt cannot settle.

The `agentPlanStep` workflow carries only IDs. It runs specialists beside its loop and steps again when one finishes.
Saved tasks do not signal plans, so a waiting plan reads them again every 30 seconds. `agentPlanRecovery` wakes every
active plan each minute.

When the task summary reaches completed or failed, the scheduler closes an active plan with that outcome.
A failed branch blocks its dependents but does not stop independent work. Failed plans are terminal:
they cannot be resumed or edited. Recovery also closes older active plans whose tasks already finished.

Chat creates and changes plans with tools in `tools.ts`. `plans.create` stores the first outline, `plans.update`
applies a versioned batch of changes, and `plans.read` returns the outline with completed results. Each call wakes the
scheduler at once through the worker's plan dispatcher; the recovery sweep covers a lost wake. The tools refuse a plan
from another chat, so plan content stays in its chat. The model cannot set the budget; plans use the default budget.
Only the starter receives results, and a result is withheld when its sources are no longer readable. Saved agents and
Slack cannot use the tools. The `# Plans` prompt section routes complex work to the built-in
[Planning procedure](skills/planning/SKILL.md).

Chat runs sub-agents with `agents.delegate` ([`subagents.ts`](src/subagents.ts),
[`subagent-contracts.ts`](src/subagent-contracts.ts)). One call starts up to five sub-agents in parallel: activated
saved agents, which run as private child tasks of the turn, or temporary helpers that the chat names and gives a role,
instructions, and a subset of its read-only tools. A helper's tools are the intersection of its request, the read-only
helper tools, and the tools the chat is offered; a saved child's delegation tools are its definition's tools that the
chat is offered. Helpers cannot delegate again, and saved children start at depth one of the existing limit of three. The reply waits for every sub-agent. Each has a time limit (default 180 seconds, at most
300); one that reaches it ends as timed out, one stopped by the user or by stopping the reply ends as stopped, and both
return their partial output. The tool result holds every report, bounded by the reply's 10% tool-result cap. Helpers
charge the reply's credit hold; a saved child spends from its own task allowance (25 credits unless the call asks for
up to 100), and its spending is counted in the call's total. The worker publishes live cards as `subagents` stream events, and the chat shows them with Sprout's `AgentFanout`. A helper's card names the chat's model family, shown with its maker's logo; a saved agent's card names its `agentId`, shown with its `AgentAvatar`.
Saved agents and Slack cannot use the tool. Telemetry records kind, outcome, duration, and credits only.

Planning plans use `0046_planning.sql`: original requirements, receipt-backed
prerequisites, a draft lifecycle, main-agent ownership, and a final verification
task. `plans.claim` binds one task attempt to the live chat turn, generation, and
epoch. `plans.report` checks fresh same-turn receipts after that claim, every
criterion, and final coverage of the original requirements. Reports remain
visible under task details after current source access is checked. A worker
return enters `verifying`; plain prose cannot complete a Planning requirement.
Legacy completed plans are not labelled newly verified.

The Normal/Plan composer control persists typed intent on the send command and
turn. Plan mode automatically loads Planning and rejects writes, business drafts,
activation, and dispatch before their callbacks. `plans.start` or the starter's
Start button begins a saved draft without approving its business actions.
Internal slices requeue the original turn with a new generation and its existing
receipts, at most 100 times; they do not fabricate human messages or reset the
1,000-call turn allowance. Waiting for workers releases the model. A worker result,
Pause/Stop, or newer human message durably wakes the waiting turn.

People read plans and control them through [`apps/api/src/agent-plans.ts`](../../apps/api/src/agent-plans.ts). Anyone who
can read the chat may list its plans and read an authorized outline. Only the starter may start, pause, resume, or stop a plan
through the service's `control`; nobody edits the outline by hand. Pause cancels running specialists, and their tasks start again on
resume; a cancelled attempt does not count toward a task's three tries. Saved tasks keep running within their
allowance. Resume may raise, never lower, the budget (`0024_agent_plan_controls.sql`); models cannot change it. Stop
cancels every unfinished task, settles open attempts, and pauses the saved tasks the plan started. Controls are
version-checked, replay their receipt, and record a `controlled` event by `starter`.

A saved task that waits for an answer or approval keeps its question in that task. The plan view gives the starter its
`waitingTaskId` so the canvas can link to the existing task page. The view also reports why a paused plan stopped
(`starter`, `budget`, `starter-access`, or `progress`). Every plan write sends a chat change notification with the `planId`, so
an open chat can read the plan again.

The web chat lists a chat's plans after its messages and opens one in the Canvas as a read-only outline
(`apps/web/src/features/chat/plans.tsx`, `@tulipfarm/sprout/plan-outline`). Pause, resume, and stop sit
on the starter's plan card in chat, never in the outline. A budget pause offers one resume that doubles the budget,
up to the task maximum.

Current limits: delegated child tasks share their parent's credit flow but their
tool calls are not counted against the plan. Claimed coordinator model work uses
the existing chat billing identity and flow, with separate plan-attempt attribution;
prerequisite research before the claim retains ordinary chat billing.
The ledger's provider-cost conversion and whole-credit rounding also bound plan
admission. Model and business-tool elapsed time are recorded once per durable
receipt, including a known result that arrives after a pause.
Usage of a specialist cancelled by a pause counts its credits but not its tool calls.

## Transactions and retries

`execute` locks the authorization row and persisted run before invoking a registered tool. Resource factories use the same transaction, so record effects and tool receipts commit atomically. Calls have immutable IDs and a bounded sequence of at most 100 entries. A predecessor that has not completed prevents later calls from executing.

`boundedAgentTool` is the Temporal workflow. It sends only workspace, run and call IDs to `executeAgentTool`, receives a bounded status, and waits without holding a database integration. `resumeAgentTool` wakes it early. Each resumed invocation reloads persisted authority. The workflow stops polling after 120 waits and returns `waiting`; the persisted operation can be resumed with the same IDs.

Arguments, definition text, results, and record values stay in workspace tables. Tool errors expose bounded codes. A result read checks both the current human reader and agent authority.

## Verification

Start the repository's local PostgreSQL and Temporal services, export `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` for the local Soul bucket, then run:

```sh
pnpm --filter @tulipfarm/agents test
pnpm --filter @tulipfarm/agents test:integration
pnpm check
NODE_ENV=development R2_SOUL_BUCKET=tulipfarm-cloud-soul-local pnpm --filter @tulipfarm/worker test:agents
```

The integration suite uses disposable local databases, restricted workspace logins, and the local Soul bucket. It executes the real registry and observes a Temporal timer before resumption. The suite covers schema creation, records, record-only caller denial, admin callers constrained by agent limits, and revocation during a destructive confirmation wait.

The [production-entry test](../../apps/worker/test/agent-composition.integration.mjs) starts the compiled ordinary and maintenance workers as child processes. It persists calls through the same agent composition used by the ordinary worker. The real API dispatcher delivers schema work, and an authenticated human confirms through HTTP. The test kills the ordinary worker during a durable wait, revokes activation, restarts the worker, and verifies denial with the original data retained. It checks decoded workflow payloads and captured worker output for private values and credentials.

The ordinary worker registers the bounded workflow and activity when isolated storage is enabled. It shares the authoring runtime pools and needs no migration or confirmation credentials. Trusted operator code owns run admission through the existing store functions. The deterministic executor is one path within the broader agent product mapped above.

The executor description preserves its 27 September 2026 inspection. Later
agent-product evidence belongs to [Agents delivery](../../docs/agents-delivery.md).
