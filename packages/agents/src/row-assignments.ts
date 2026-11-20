import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AccessDenied } from '@tulipfarm/access';
import { activeGeneration, readRecord, writeRunState } from '@tulipfarm/tables/store';
import { taskFields, type RunState } from '@tulipfarm/tables/tasks-table';
import type { TableDefinition, TableValues } from '@tulipfarm/tables/definition';
import { agentCompatibility, relation, type AgentStorage, type AgentTransaction } from './store.ts';

/** Run limits for one wake: the agent's usual defaults. */
const runLimits = { toolCalls: 100, activeMilliseconds: 300000, credits: 100 };
const defaultAgentConcurrency = 3;
const defaultWorkspaceConcurrency = 10;
/** A claim whose run never got recorded, such as after a worker crash, is retried after this long. */
const claimTimeoutSeconds = 120;
const maxWakeDays = 30;
/** Short Inbox reasons for each way an agent task pauses. */
const pauseReasons: Record<string, string> = {
  user: 'Paused by a person',
  'limit.toolCalls': 'Run limit reached',
  'limit.activeTime': 'Run limit reached',
  'limit.credits': 'Run limit reached',
  'limit.steps': 'Run limit reached',
  'limit.workspaceCredits': 'Out of credits',
  model: 'The model is unavailable',
  context: 'The context is too large',
  file: "A file couldn't be read",
  plan: 'Its plan was stopped',
  approval: 'Waiting for approval',
  decision: "The agent couldn't continue",
};

type Starter = (
  workspaceId: string,
  userId: string,
  input: { requestId: string; agentId: string; text: string; limits: typeof runLimits },
) => Promise<{ id: string }>;
type Pauser = (workspaceId: string, userId: string, taskId: string) => Promise<unknown>;

const assignmentSchema = z.object({
  table_id: z.uuid(),
  row_id: z.uuid(),
  agent_id: z.uuid(),
  sponsor_membership_id: z.uuid(),
  generation: z.coerce.number(),
  run_state: z.enum(['queued', 'working', 'waiting', 'done', 'failed', 'stopped']),
  current_task_id: z.uuid().nullable(),
  pending_wakes: z.number(),
});

const requestId = (seed: string) => {
  const hex = createHash('sha256').update(`row-assignment:${seed}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${((parseInt(hex[16]!, 16) & 3) | 8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

/** Reads the agent's closing directive: `STATUS: done|waiting <reason>|continue` and an optional `WAKE: <ISO time>`. */
export function readRunReply(text: string, now = new Date()) {
  type Outcome = 'done' | 'waiting' | 'continue';
  let outcome = 'continue' as Outcome;
  let reason: string | null = null;
  let wakeAt: Date | null = null;
  const kept: string[] = [];
  for (const line of text.split('\n')) {
    const status = /^\s*\**STATUS:\**\s*(done|waiting|continue)\b\s*(.*)$/i.exec(line);
    const wake = /^\s*\**WAKE:\**\s*(\S+)\s*$/i.exec(line);
    if (status) {
      outcome = status[1]!.toLowerCase() as Outcome;
      reason = status[2]?.trim().slice(0, 200) || null;
    } else if (wake) {
      const at = new Date(wake[1]!);
      if (!Number.isNaN(at.getTime()) && at > now && at.getTime() - now.getTime() <= maxWakeDays * 86400000)
        wakeAt = at;
    } else kept.push(line);
  }
  return { outcome, reason, wakeAt, note: kept.join('\n').trim() };
}

function displayValue(definition: TableDefinition, fieldId: string, values: TableValues): string | null {
  const field = definition.fields.find(candidate => candidate.id === fieldId);
  const value = values[fieldId as keyof TableValues];
  if (!field || !value) return null;
  switch (value.kind) {
    case 'text':
    case 'numeric':
    case 'date':
    case 'timestamp':
      return value.value;
    case 'boolean':
      return value.value ? 'Yes' : 'No';
    case 'single-select':
      return field.kind === 'single-select'
        ? (field.options.find(option => option.id === value.optionId)?.label ?? null)
        : null;
    case 'multi-select':
      return field.kind === 'multi-select'
        ? field.options
            .filter(option => value.optionIds.includes(option.id))
            .map(option => option.label)
            .join(', ')
        : null;
    case 'relationship':
      return value.recordIds.map(id => `row ${id}`).join(', ');
    case 'actor':
      return `${value.actor.type} ${value.actor.id}`;
    default:
      return null;
  }
}

export async function rowExists(tx: AgentTransaction, tableId: string, rowId: string) {
  const generation = await activeGeneration(tx, tableId).catch(() => null);
  return Boolean(generation && (await readRecord(tx, generation, rowId)));
}

async function runBrief(tx: AgentTransaction, tableId: string, rowId: string, agentName: string) {
  const generation = await activeGeneration(tx, tableId);
  const row = await readRecord(tx, generation, rowId);
  if (!row) return null;
  const { definition } = generation;
  const fields = definition.fields
    .filter(field => field.id !== taskFields.runState)
    .map(field => {
      const value = displayValue(definition, field.id, row.values);
      return value === null
        ? null
        : `- ${field.label}: ${value.slice(0, field.id === taskFields.description ? 3000 : 400)}`;
    })
    .filter(Boolean);
  const thread = z
    .array(
      z.object({
        kind: z.string(),
        body: z.string().nullable(),
        event: z.record(z.string(), z.unknown()).nullable(),
        author: z.string().nullable(),
        deleted_at: z.date().nullable(),
      }),
    )
    .parse(
      (
        await tx.client.query(
          `SELECT * FROM (SELECT i.kind,i.body,i.event,i.created_at,i.id,i.deleted_at,
            COALESCE(ag.display_name,CASE WHEN i.author_membership_id IS NOT NULL THEN 'member ' || i.author_membership_id END) AS author
          FROM ${relation(tx, 'tf_row_thread_items')} i
          LEFT JOIN ${relation(tx, 'tf_agents')} ag ON ag.id=i.author_agent_id
          WHERE i.table_id=$1 AND i.row_id=$2 ORDER BY i.created_at DESC,i.id DESC LIMIT 20) recent ORDER BY created_at,id`,
          [tableId, rowId],
        )
      ).rows,
    )
    .map(item =>
      item.deleted_at
        ? null
        : item.kind === 'event'
          ? `- event: ${JSON.stringify(item.event)}`
          : `- ${item.kind} by ${item.author ?? 'a member'}: ${(item.body ?? '').slice(0, 600)}`,
    )
    .filter(Boolean);
  const text = [
    `You are ${agentName}, assigned to a row in the table "${definition.label}" (table ${tableId}, row ${rowId}). Work on it now, on behalf of the member who assigned it.`,
    '',
    'Row fields:',
    ...fields,
    '',
    thread.length ? 'Row thread, oldest first:' : 'The row thread is empty.',
    ...thread,
    '',
    'The row and its thread are your only memory between runs. Use your table tools to read or edit the row when you have access.',
    'Your reply is posted to the row thread as a progress note: say what you did, what you are waiting for and what comes next.',
    'End your reply with exactly one line: "STATUS: done" when the work is finished, "STATUS: waiting <short reason>" when you need a person, or "STATUS: continue" to keep working later.',
    `With "STATUS: continue" you may add a line "WAKE: <ISO 8601 time>" up to ${maxWakeDays} days ahead to be woken then.`,
  ].join('\n');
  return text.length > 8000 ? `${text.slice(0, 7000)}\n…\n${text.slice(-900)}` : text;
}

const visibleState = (state: string): RunState | null => (state === 'stopped' ? null : (state as RunState));

async function syncRunState(tx: AgentTransaction, tableId: string, rowId: string, state: string) {
  await writeRunState(tx, { tableId, recordId: rowId, state: visibleState(state) });
}

async function postNote(
  tx: AgentTransaction,
  assignment: { table_id: string; row_id: string; agent_id: string },
  taskId: string,
  kind: 'progress' | 'event',
  content: string | Record<string, unknown>,
) {
  await tx.client.query(
    `INSERT INTO ${relation(tx, 'tf_row_thread_items')}(id,table_id,row_id,kind,author_agent_id,agent_task_id,body,event) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      randomUUID(),
      assignment.table_id,
      assignment.row_id,
      kind,
      assignment.agent_id,
      taskId,
      typeof content === 'string' ? content.slice(0, 20000) : null,
      typeof content === 'string' ? null : JSON.stringify(content),
    ],
  );
}

async function notifySponsor(
  tx: AgentTransaction,
  assignment: { table_id: string; row_id: string; sponsor_membership_id: string },
  kind: 'waiting' | 'finished',
  sourceId: string,
  summary: string,
) {
  await tx.client.query(
    `INSERT INTO ${relation(tx, 'tf_inbox_items')}(id,membership_id,kind,table_id,row_id,source_id,summary) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
    [
      randomUUID(),
      assignment.sponsor_membership_id,
      kind,
      assignment.table_id,
      assignment.row_id,
      sourceId,
      summary.slice(0, 500),
    ],
  );
}

/**
 * Turns row assignments into agent runs. One `step` per workspace settles finished runs, stops runs whose assignment
 * changed, and starts queued rows within the agent and workspace limits.
 */
export function createRowAssignments(options: {
  runtime: AgentStorage;
  start: Starter;
  pause: Pauser;
  wake: (workspaceId: string, taskId: string) => Promise<unknown>;
}) {
  const { runtime } = options;

  async function settle(workspaceId: string) {
    return runtime.transaction(workspaceId, agentCompatibility, async tx => {
      const installed = (
        await tx.client.query('SELECT to_regclass($1) IS NOT NULL AS installed', [relation(tx, 'tf_row_assignments')])
      ).rows[0]?.installed;
      if (!installed) return { stops: [], installed: false };
      await tx.client.query(
        `UPDATE ${relation(tx, 'tf_row_assignments')} SET run_state='queued',pending_wakes=pending_wakes+1,wake_at=NULL,queued_at=clock_timestamp(),updated_at=clock_timestamp()
        WHERE wake_at<=clock_timestamp() AND current_task_id IS NULL AND run_state<>'stopped'`,
      );
      await tx.client.query(
        `UPDATE ${relation(tx, 'tf_row_assignments')} SET run_state='queued',pending_wakes=GREATEST(pending_wakes,1),queued_at=COALESCE(queued_at,clock_timestamp()),updated_at=clock_timestamp()
        WHERE current_task_id IS NULL AND ((pending_wakes>0 AND run_state IN ('done','failed','waiting'))
          OR (run_state='working' AND updated_at<clock_timestamp()-make_interval(secs=>${claimTimeoutSeconds})))
          AND NOT (run_state='waiting' AND reason IN ('Needs reassignment','Agent unavailable','Out of credits') AND pending_wakes=0)`,
      );
      const rows = z
        .array(
          assignmentSchema.extend({
            status: z.string().nullable(),
            pause_reason: z.string().nullable(),
            run_generation: z.coerce.number().nullable(),
            owner_user: z.string().nullable(),
          }),
        )
        .parse(
          (
            await tx.client.query(
              `SELECT a.*,t.status,t.pause_reason,r.generation AS run_generation,t.owner_user_id AS owner_user
              FROM ${relation(tx, 'tf_row_assignments')} a
              LEFT JOIN ${relation(tx, 'tf_agent_tasks')} t ON t.id=a.current_task_id
              LEFT JOIN ${relation(tx, 'tf_row_assignment_runs')} r ON r.task_id=a.current_task_id
              WHERE a.current_task_id IS NOT NULL ORDER BY a.table_id,a.row_id FOR UPDATE OF a`,
            )
          ).rows,
        );
      const stops: { taskId: string; userId: string }[] = [];
      for (const row of rows) {
        const taskId = row.current_task_id!;
        const close = async (outcome: string, state: string, reason: string | null) => {
          await tx.client.query(
            `UPDATE ${relation(tx, 'tf_row_assignment_runs')} SET ended_at=clock_timestamp(),outcome=$2 WHERE task_id=$1 AND ended_at IS NULL`,
            [taskId, outcome],
          );
          await tx.client.query(
            `UPDATE ${relation(tx, 'tf_row_assignments')} SET current_task_id=NULL,run_state=$3,reason=$4,updated_at=clock_timestamp() WHERE table_id=$1 AND row_id=$2`,
            [row.table_id, row.row_id, state, reason],
          );
        };
        if (row.run_state === 'stopped' || row.run_generation !== row.generation) {
          if (row.owner_user && ['pending', 'waiting-approval', 'waiting-clarification'].includes(row.status ?? ''))
            stops.push({ taskId, userId: row.owner_user });
          await tx.client.query(
            `UPDATE ${relation(tx, 'tf_row_assignment_runs')} SET ended_at=clock_timestamp(),outcome='stopped' WHERE task_id=$1 AND ended_at IS NULL`,
            [taskId],
          );
          await tx.client.query(
            `UPDATE ${relation(tx, 'tf_row_assignments')} SET current_task_id=NULL,updated_at=clock_timestamp() WHERE table_id=$1 AND row_id=$2`,
            [row.table_id, row.row_id],
          );
          if (await rowExists(tx, row.table_id, row.row_id))
            await postNote(tx, row, taskId, 'event', { type: 'run-stopped' });
          if (row.run_state === 'stopped') await syncRunState(tx, row.table_id, row.row_id, 'stopped');
          continue;
        }
        if (row.status === 'pending') {
          if (row.run_state !== 'working') {
            await tx.client.query(
              `UPDATE ${relation(tx, 'tf_row_assignments')} SET run_state='working',reason=NULL,updated_at=clock_timestamp() WHERE table_id=$1 AND row_id=$2`,
              [row.table_id, row.row_id],
            );
            await syncRunState(tx, row.table_id, row.row_id, 'working');
          }
          continue;
        }
        if (row.status === 'waiting-approval' || (row.status === 'paused' && row.pause_reason === 'approval')) {
          if (row.run_state !== 'waiting') {
            await tx.client.query(
              `UPDATE ${relation(tx, 'tf_row_assignments')} SET run_state='waiting',reason='Waiting for approval',updated_at=clock_timestamp() WHERE table_id=$1 AND row_id=$2`,
              [row.table_id, row.row_id],
            );
            await syncRunState(tx, row.table_id, row.row_id, 'waiting');
            await postNote(tx, row, taskId, 'event', { type: 'approval-requested' });
            await notifySponsor(tx, row, 'waiting', taskId, 'An agent run is waiting for your approval');
          }
          continue;
        }
        const reply = z
          .object({ text: z.string() })
          .optional()
          .parse(
            (
              await tx.client.query(
                `SELECT text FROM ${relation(tx, 'tf_agent_task_messages')} WHERE task_id=$1 AND role='agent' ORDER BY sequence DESC LIMIT 1`,
                [taskId],
              )
            ).rows[0],
          );
        const parsed = readRunReply(reply?.text ?? '');
        if (parsed.note) await postNote(tx, row, taskId, 'progress', parsed.note);
        let outcome: string;
        let state: string;
        let reason: string | null = null;
        if (row.status === 'completed') {
          if (parsed.outcome === 'done') [outcome, state] = ['done', 'done'];
          else if (parsed.outcome === 'waiting')
            [outcome, state, reason] = ['waiting', 'waiting', parsed.reason ?? 'Needs a person'];
          else [outcome, state] = ['finished', parsed.wakeAt ? 'working' : 'done'];
        } else if (row.status === 'waiting-clarification')
          [outcome, state, reason] = ['waiting', 'waiting', 'Asked a question'];
        else if (row.status === 'paused')
          [outcome, state, reason] = ['waiting', 'waiting', pauseReasons[row.pause_reason ?? ''] ?? 'Paused'];
        else [outcome, state, reason] = ['failed', 'failed', 'The run failed'];
        await close(outcome, state, reason);
        if (parsed.wakeAt && row.status === 'completed')
          await tx.client.query(
            `UPDATE ${relation(tx, 'tf_row_assignments')} SET wake_at=$3 WHERE table_id=$1 AND row_id=$2`,
            [row.table_id, row.row_id, parsed.wakeAt],
          );
        await syncRunState(tx, row.table_id, row.row_id, state);
        if (state === 'waiting') await notifySponsor(tx, row, 'waiting', taskId, reason ?? 'Waiting for a person');
        if (state === 'done' || state === 'failed')
          await notifySponsor(tx, row, 'finished', taskId, state === 'done' ? 'Done' : (reason ?? 'Failed'));
      }
      return { stops, installed: true };
    });
  }

  async function claim(workspaceId: string) {
    return runtime.transaction(workspaceId, agentCompatibility, async tx => {
      await tx.client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 648301))', [`${tx.schema}:assignments`]);
      const limits = z
        .object({ workspace: z.number().nullable() })
        .parse(
          (
            await tx.client.query(
              `SELECT (SELECT concurrent FROM ${relation(tx, 'tf_workspace_assignment_limits')}) AS workspace`,
            )
          ).rows[0],
        );
      const working = z
        .array(z.object({ agent_id: z.uuid(), count: z.number() }))
        .parse(
          (
            await tx.client.query(
              `SELECT agent_id,count(*)::integer AS count FROM ${relation(tx, 'tf_row_assignments')} WHERE run_state='working' GROUP BY agent_id`,
            )
          ).rows,
        );
      const perAgent = new Map(working.map(row => [row.agent_id, row.count]));
      let total = working.reduce((sum, row) => sum + row.count, 0);
      const queued = z
        .array(
          assignmentSchema.extend({
            agent_name: z.string(),
            agent_usable: z.boolean(),
            agent_limit: z.number().nullable(),
            daily_runs: z.number().nullable(),
            runs_today: z.number(),
            sponsor_user: z.string().nullable(),
            run_count: z.number(),
          }),
        )
        .parse(
          (
            await tx.client.query(
              `SELECT a.*,ag.display_name AS agent_name,
                (ag.saved_revision IS NOT NULL AND ag.deleted_at IS NULL AND ag.enabled) AS agent_usable,
                l.concurrent AS agent_limit,l.daily_runs,
                (SELECT count(*)::integer FROM ${relation(tx, 'tf_row_assignment_runs')} r WHERE r.agent_id=a.agent_id AND r.started_at>=date_trunc('day',clock_timestamp())) AS runs_today,
                (SELECT count(*)::integer FROM ${relation(tx, 'tf_row_assignment_runs')} r WHERE r.table_id=a.table_id AND r.row_id=a.row_id AND r.generation=a.generation) AS run_count,
                m.user_id AS sponsor_user
              FROM ${relation(tx, 'tf_row_assignments')} a
              JOIN ${relation(tx, 'tf_agents')} ag ON ag.id=a.agent_id
              LEFT JOIN ${relation(tx, 'tf_agent_assignment_limits')} l ON l.agent_id=a.agent_id
              LEFT JOIN ${relation(tx, 'tf_memberships')} m ON m.id=a.sponsor_membership_id AND m.removed_at IS NULL
              WHERE a.run_state='queued' AND a.current_task_id IS NULL
              ORDER BY a.queued_at,a.table_id,a.row_id LIMIT 50 FOR UPDATE OF a`,
            )
          ).rows,
        );
      const claims: {
        tableId: string;
        rowId: string;
        agentId: string;
        generation: number;
        userId: string;
        requestId: string;
        text: string;
      }[] = [];
      const hold = async (row: (typeof queued)[number], state: 'queued' | 'waiting', reason: string) => {
        await tx.client.query(
          `UPDATE ${relation(tx, 'tf_row_assignments')} SET run_state=$3,reason=$4,pending_wakes=CASE WHEN $3='waiting' THEN 0 ELSE pending_wakes END,updated_at=clock_timestamp() WHERE table_id=$1 AND row_id=$2`,
          [row.table_id, row.row_id, state, reason],
        );
        if (state === 'waiting') {
          await syncRunState(tx, row.table_id, row.row_id, 'waiting');
          await notifySponsor(tx, row, 'waiting', randomUUID(), reason);
        }
      };
      for (const row of queued) {
        if (!row.agent_usable) {
          await hold(row, 'waiting', 'Agent unavailable');
          continue;
        }
        if (!row.sponsor_user) {
          await hold(row, 'waiting', 'Needs reassignment');
          continue;
        }
        const agentLimit = row.agent_limit ?? defaultAgentConcurrency;
        if ((perAgent.get(row.agent_id) ?? 0) >= agentLimit) {
          await hold(row, 'queued', `Waiting: ${row.agent_name} is working on ${agentLimit} rows`);
          continue;
        }
        if (row.daily_runs !== null && row.runs_today >= row.daily_runs) {
          await hold(row, 'queued', `Waiting: ${row.agent_name} reached its daily run limit`);
          continue;
        }
        if (total >= (limits.workspace ?? defaultWorkspaceConcurrency)) {
          await hold(row, 'queued', 'Waiting: the workspace limit on working rows is reached');
          continue;
        }
        const text = await runBrief(tx, row.table_id, row.row_id, row.agent_name);
        if (!text) {
          await hold(row, 'waiting', 'Row unavailable');
          continue;
        }
        perAgent.set(row.agent_id, (perAgent.get(row.agent_id) ?? 0) + 1);
        total += 1;
        await tx.client.query(
          `UPDATE ${relation(tx, 'tf_row_assignments')} SET run_state='working',reason=NULL,pending_wakes=0,updated_at=clock_timestamp() WHERE table_id=$1 AND row_id=$2`,
          [row.table_id, row.row_id],
        );
        await syncRunState(tx, row.table_id, row.row_id, 'working');
        claims.push({
          tableId: row.table_id,
          rowId: row.row_id,
          agentId: row.agent_id,
          generation: row.generation,
          userId: row.sponsor_user,
          requestId: requestId(`${row.table_id}:${row.row_id}:${row.generation}:${row.run_count}`),
          text,
        });
      }
      return claims;
    });
  }

  async function record(
    workspaceId: string,
    claimed: Awaited<ReturnType<typeof claim>>[number],
    taskId: string | null,
    failure?: string,
  ) {
    await runtime.transaction(workspaceId, agentCompatibility, async tx => {
      const current = assignmentSchema
        .optional()
        .parse(
          (
            await tx.client.query(
              `SELECT * FROM ${relation(tx, 'tf_row_assignments')} WHERE table_id=$1 AND row_id=$2 FOR UPDATE`,
              [claimed.tableId, claimed.rowId],
            )
          ).rows[0],
        );
      if (!current) return;
      if (taskId) {
        await tx.client.query(
          `INSERT INTO ${relation(tx, 'tf_row_assignment_runs')}(task_id,table_id,row_id,agent_id,generation) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
          [taskId, claimed.tableId, claimed.rowId, claimed.agentId, claimed.generation],
        );
        // A reassignment during the start leaves the run for `settle` to stop.
        await tx.client.query(
          `UPDATE ${relation(tx, 'tf_row_assignments')} SET current_task_id=$3,updated_at=clock_timestamp() WHERE table_id=$1 AND row_id=$2 AND current_task_id IS NULL`,
          [claimed.tableId, claimed.rowId, taskId],
        );
        return;
      }
      if (current.generation !== claimed.generation || current.run_state !== 'working') return;
      await tx.client.query(
        `UPDATE ${relation(tx, 'tf_row_assignments')} SET run_state='waiting',reason=$3,updated_at=clock_timestamp() WHERE table_id=$1 AND row_id=$2`,
        [claimed.tableId, claimed.rowId, failure ?? 'The run could not start'],
      );
      await syncRunState(tx, claimed.tableId, claimed.rowId, 'waiting');
      await notifySponsor(tx, current, 'waiting', randomUUID(), failure ?? 'The run could not start');
    });
  }

  /** Settles and stops runs; starts new ones only when `startAllowed`, so turning the feature off lets working runs finish. */
  async function step(workspaceId: string, startAllowed: boolean) {
    const settled = await settle(workspaceId);
    if (!settled.installed) return;
    for (const stop of settled.stops) await options.pause(workspaceId, stop.userId, stop.taskId).catch(() => undefined);
    if (!startAllowed) return;
    for (const claimed of await claim(workspaceId)) {
      let task: { id: string };
      try {
        task = await options.start(workspaceId, claimed.userId, {
          requestId: claimed.requestId,
          agentId: claimed.agentId,
          text: claimed.text,
          limits: runLimits,
        });
      } catch (error) {
        const code = error instanceof Error ? ('code' in error ? String(error.code) : error.name) : '';
        await record(
          workspaceId,
          claimed,
          null,
          error instanceof AccessDenied
            ? "The sponsor can't use this agent"
            : code
              ? `The run could not start (${code})`
              : undefined,
        );
        continue;
      }
      await record(workspaceId, claimed, task.id);
      await options.wake(workspaceId, task.id);
    }
  }

  return { step };
}

/** Queues a wake for a row's agent, as a comment or Run now does. Returns false when the row has no agent assignee. */
export async function wakeRow(tx: AgentTransaction, tableId: string, rowId: string, sponsorMembershipId?: string) {
  const changed = await tx.client.query(
    `UPDATE ${relation(tx, 'tf_row_assignments')} SET pending_wakes=pending_wakes+1,
      run_state=CASE WHEN current_task_id IS NULL THEN 'queued' ELSE run_state END,
      queued_at=CASE WHEN current_task_id IS NULL THEN clock_timestamp() ELSE queued_at END,
      reason=CASE WHEN current_task_id IS NULL THEN NULL ELSE reason END,
      sponsor_membership_id=COALESCE($3,sponsor_membership_id),updated_at=clock_timestamp()
    WHERE table_id=$1 AND row_id=$2 AND run_state<>'stopped' RETURNING current_task_id`,
    [tableId, rowId, sponsorMembershipId ?? null],
  );
  if (changed.rowCount && !changed.rows[0]?.current_task_id) await syncRunState(tx, tableId, rowId, 'queued');
  return Boolean(changed.rowCount);
}
