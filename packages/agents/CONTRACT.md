# Bounded agent integration contract

Inspected and verified on 27 September 2026. S7 owns this package. Shared authorization is implemented in `packages/access` by the resource-service partition.

## Shared policy

Resource operations accept either an authenticated user ID or an `Actor`. The agent actor is `{ kind: 'agent', runId }`. `@tulipfarm/access` loads authority from workspace-local tables under the authorization lock.

Every scope is an array of `{ assetId: uuid, permissions: ResourcePermission[] }`. Creation targets destination team IDs. Record and schema operations target resource IDs. There are no wildcards. Shared access intersects current agent team grants, limits, activation scope, and requested run scope. Delegated runs also require the exact initiating user and membership incarnation with current permission. Scheduled runs require current schedule authorization instead of the schedule creator's membership. Human admin status bypasses only the caller's team restriction.

## Persistent relations

`common/0007_agents.sql` adds these platform-owned common tables:

- `tf_agents` stores identity and enabled state.
- `tf_agent_definitions` stores immutable saved definitions keyed by agent ID and SHA-256 revision.
- `tf_agent_activations` authorizes an exact definition revision and scope. Only revocation can change an existing activation.
- `tf_agent_teams` and `tf_agent_limits` store current assignments and limits.
- `tf_agent_schedules` stores independently revocable admin-authorized scheduled scope and its action. An inspection keeps its `schema.inspect` call. A prompt keeps `{ kind: 'task', text, limits }` and the activation scope. The activation and action fix a schedule's identity; its interval can change in place (common migration 0009).
- `tf_agent_tasks.schedule_id` (common migration 0008) names the schedule that started a sponsor-owned task. At most one such task per schedule is pending or waiting.
- `tf_agent_runs` stores delegated or scheduled identity, pinned activation and definition, scope, and status.
- `tf_agent_tool_calls` stores immutable call arguments and sequence, plus mutable execution status and result.

The migration adds `agent_run_id` to authoring commands and migration jobs. Exactly one of `membership_id` and `agent_run_id` must be present. The delegated run itself retains the human incarnation. Agent authoring idempotency uses the unique pair `(agent_run_id, request_id)`.

Migration and confirmation roles receive read-only access to agent policy and run relations. They receive no access to tool arguments or results and cannot edit policy. Runtime column grants prevent rewriting definitions, activation identity or scope, run identity or scope, and tool arguments.

`agentCommonMigrations()` appends 0007 after `resourceCommonMigrations()`. The agent runtime accepts common receipt counts 4 through 6. The ordinary application composition installs six receipts, including confirmation history and both governance migrations. Composing additional common migrations requires an explicit compatibility update.

## Runtime composition

`createAgentExecutor` takes `{ runtime }`. It exposes definition save, activation, configuration, schedule authorization, delegated and scheduled admission, call admission, execution, result reading, and revocation. It needs no Soul writer because schema tools use `createResourceCommands` to persist authoring requests.

`execute` receives workspace, run, and call IDs. It validates the persisted call, loads the exact pinned definition, and invokes `createToolRegistry`. The registry calls `createAgentRecordTools`, which serves resource v2 definitions and records. A transaction-bound runtime lets resource effects and tool receipts commit together.

Agents never save schemas. Schema changes use reviewed resource proposals. The agent process receives no migration or confirmation credentials.

The ordinary worker registers `boundedAgentTool` through `apps/worker/src/workflows.ts` and `executeAgentTool` through `apps/worker/src/agent-composition.ts`. Agent execution shares the table-authoring runtime and its pool lifecycle. The worker rejects maintenance and confirmation credentials at startup. The worker package dependency and Docker image include the agent package and its workflow export.

Workflow arguments and Activity results contain IDs and bounded status only. The workflow waits with a durable timer or resume signal, then calls the executor again. It has a 120-wait polling bound. Call arguments, schema definitions and record results remain in workspace storage.

Trusted operator code uses the exposed store functions to save, activate, configure, start, and queue calls. Human actors contain a user ID and membership incarnation, never a supplied role. Store operations check current database authority. A Temporal start supplies only persisted IDs and cannot create a run or grant permission. No new public run or activation endpoint is required for this operator-owned entry path.

## Verified boundary

The integration tests execute the real registry, restricted PostgreSQL logins, real Git revisions in the local R2 bucket, and a Temporal worker. They verify resource creation through durable dispatch, all record mutations, schema inspection, replay safety, restricted caller and agent-limit denials, scheduled execution after creator departure, exact definition pinning, replaced-membership denial, and revocation after a Temporal wait.

`apps/worker/test/agent-composition.integration.mjs` starts compiled `dist/worker.js` and `dist/storage-worker.js` child processes. A real authenticated API dispatcher delivers the agent's schema commands. The test verifies record creation and reads, six common receipts, a real confirmation wait, worker termination and restart, activation revocation, retained data, forged-run denial, and private-value exclusion from decoded workflow histories and worker output. The ordinary worker receives only authoring-registry and workspace-runtime database access.

The destructive journey uses the resource domain's authenticated human confirmation endpoint. The existing web confirmation UI is outside this partition's runtime test. Agent-authoring UI, model-selected calls, and production deployment remain separate work. No model execution or deployed product journey is claimed.
