import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AuthorizationTransaction } from '@tulipfarm/access';
import { qualified } from '@tulipfarm/workspace-storage/runtime';
import { actorKey, type Actor, type TableDefinition, type TableValues } from './definition.ts';
import {
  runStateChanged,
  runStateOptions,
  taskFields,
  tasksRegistrationSchema,
  TaskTableError,
  type RunState,
  type TasksRegistration,
} from './tasks-table.ts';

type Tx = AuthorizationTransaction;
const relation = (tx: Tx, name: string) => qualified(tx.schema, name);

// The Tasks registration never changes inside a transaction, and every row write checks it, so each transaction reads it once.
const registrations = new WeakMap<object, Promise<TasksRegistration | null>>();

export function tasksTable(tx: Tx): Promise<TasksRegistration | null> {
  let registration = registrations.get(tx);
  if (!registration) {
    registration = readTasksTable(tx);
    registrations.set(tx, registration);
    registration.catch(() => registrations.delete(tx));
  }
  return registration;
}

async function readTasksTable(tx: Tx): Promise<TasksRegistration | null> {
  const installed = (
    await tx.client.query('SELECT to_regclass($1) IS NOT NULL AS installed', [relation(tx, 'tf_row_assignments')])
  ).rows[0]?.installed;
  if (!installed) return null;
  const row = (
    await tx.client.query(
      `SELECT kind,core_definition AS "coreDefinition" FROM ${relation(tx, 'tf_system_tables')} WHERE kind='tasks'`,
    )
  ).rows[0];
  return row ? tasksRegistrationSchema.parse(row) : null;
}

/** The table's Assignee field, if it marks one. */
export const assigneeField = (definition: TableDefinition) =>
  definition.fields.find(field => field.kind === 'actor' && field.assignee);

const actorValue = (
  values: TableValues | null,
  fieldId: TableDefinition['fields'][number]['id'] | undefined,
): Actor | null => {
  const value = fieldId ? values?.[fieldId] : undefined;
  return value?.kind === 'actor' ? value.actor : null;
};
const sameActor = (a: Actor | null, b: Actor | null) => (a ? actorKey(a) : null) === (b ? actorKey(b) : null);

/** Who made a row change: the member, or the agent run and the member it acts for. */
type Writer = { membershipId: string; agentId: string | null; taskId: string | null };
const writerSchema = z.union([
  z.object({ kind: z.literal('human'), membershipId: z.uuid() }).loose(),
  z.object({ kind: z.literal('agent'), runId: z.uuid() }).loose(),
  z.object({ kind: z.literal('app'), viewer: z.object({ membershipId: z.uuid() }).loose() }).loose(),
]);
async function writerOf(tx: Tx, actor: unknown): Promise<Writer | null> {
  const parsed = writerSchema.safeParse(actor);
  if (!parsed.success) return null;
  const value = parsed.data;
  if (value.kind === 'human') return { membershipId: value.membershipId, agentId: null, taskId: null };
  if (value.kind === 'app') return { membershipId: value.viewer.membershipId, agentId: null, taskId: null };
  const run = z
    .object({ membership_id: z.uuid().nullable(), agent_id: z.uuid(), task_id: z.uuid().nullable() })
    .optional()
    .parse(
      (
        await tx.client.query(
          `SELECT membership_id,agent_id,task_id FROM ${relation(tx, 'tf_agent_runs')} WHERE id=$1`,
          [value.runId],
        )
      ).rows[0],
    );
  if (!run?.membership_id) return null;
  return { membershipId: run.membership_id, agentId: run.agent_id, taskId: run.task_id };
}

export type TaskWrite = {
  tableId: string;
  recordId: string;
  definition: TableDefinition;
  before: TableValues | null;
  values: TableValues | null;
  actor: unknown;
  operation: 'create' | 'update' | 'delete' | 'restore';
  /** Set only by the assignment service, the one writer of Run state. */
  system?: boolean;
};

export type TaskPlan = {
  tasks: boolean;
  values: TableValues | null;
  writer: Writer | null;
  previous: Actor | null;
  next: Actor | null;
};

const runStateValue = (state: RunState | null) =>
  state === null ? null : ({ kind: 'single-select', optionId: runStateOptions[state] } as const);

async function requireNoCycle(tx: Tx, tableId: string, recordId: string, parentId: string) {
  if (parentId === recordId) throw new TaskTableError('parent-cycle');
  const cycle = await tx.client.query(
    `WITH RECURSIVE up(row_id,depth) AS (
      SELECT $3::uuid,0
      UNION ALL
      SELECT l.target_row,up.depth+1 FROM up JOIN ${relation(tx, 'tf_table_generation_links')} l
        JOIN ${relation(tx, 'tf_table_generations')} g ON g.id=l.generation_id AND g.state='active'
        ON l.source_table=$1 AND l.source_row=up.row_id AND l.field_id=$4 AND l.target_table=$1
      WHERE up.depth<1000
    ) SELECT 1 FROM up WHERE row_id=$2 LIMIT 1`,
    [tableId, recordId, parentId, taskFields.parent],
  );
  if (cycle.rowCount) throw new TaskTableError('parent-cycle');
}

/** Checks a row change against the Tasks and Assignee rules and returns the values to store. Null when neither applies. */
export async function prepareTaskWrite(tx: Tx, input: TaskWrite): Promise<TaskPlan | null> {
  const field = assigneeField(input.definition);
  const registration = await tasksTable(tx);
  const tasks = registration?.coreDefinition.id === input.tableId;
  if (!tasks && !field) return null;
  const previous = actorValue(input.before, field?.id);
  const next = actorValue(input.values, field?.id);
  const writer = await writerOf(tx, input.actor);
  let values = input.values === null ? null : { ...input.values };
  if (tasks && values) {
    if (!input.system) {
      if (input.operation === 'restore') values[taskFields.runState] = input.before?.[taskFields.runState] ?? null;
      else if (runStateChanged(input.before, values)) throw new TaskTableError('run-state-protected');
    }
    if (input.operation === 'create' && !actorValue(values, taskFields.reporter) && writer) {
      values[taskFields.reporter] = {
        kind: 'actor',
        actor: writer.agentId ? { type: 'agent', id: writer.agentId } : { type: 'member', id: writer.membershipId },
      };
    }
    if (writer?.taskId && input.before && !input.system) {
      const own = await tx.client.query(
        `SELECT 1 FROM ${relation(tx, 'tf_row_assignments')} WHERE table_id=$1 AND row_id=$2 AND current_task_id=$3`,
        [input.tableId, input.recordId, writer.taskId],
      );
      if (
        own.rowCount &&
        (!sameActor(previous, next) ||
          !sameActor(actorValue(input.before, taskFields.reporter), actorValue(values, taskFields.reporter)))
      )
        throw new TaskTableError('assignment-protected');
    }
    const parent = values[taskFields.parent];
    const before = input.before?.[taskFields.parent];
    if (parent?.kind === 'relationship' && JSON.stringify(parent) !== JSON.stringify(before ?? null))
      for (const target of parent.recordIds) await requireNoCycle(tx, input.tableId, input.recordId, target);
    if (!input.system && !sameActor(previous, next))
      values[taskFields.runState] = runStateValue(next?.type === 'agent' ? 'queued' : null);
  }
  if (!sameActor(previous, next) && next?.type === 'agent' && !writer) throw new TaskTableError('assignment-protected');
  return { tasks, values, writer, previous, next };
}

async function threadEvent(tx: Tx, input: TaskWrite, writer: Writer | null, event: Record<string, unknown>) {
  await tx.client.query(
    `INSERT INTO ${relation(tx, 'tf_row_thread_items')}(id,table_id,row_id,kind,author_membership_id,author_agent_id,event) VALUES($1,$2,$3,'event',$4,$5,$6)`,
    [
      randomUUID(),
      input.tableId,
      input.recordId,
      writer?.agentId ? null : (writer?.membershipId ?? null),
      writer?.agentId ?? null,
      JSON.stringify(event),
    ],
  );
}

/** Records the assignment, thread event and Inbox items for a row change that `prepareTaskWrite` accepted. */
export async function finishTaskWrite(tx: Tx, input: TaskWrite, plan: TaskPlan) {
  const { previous, next, writer } = plan;
  if (plan.values === null) {
    await tx.client.query(
      `UPDATE ${relation(tx, 'tf_row_assignments')} SET run_state='stopped',generation=generation+1,pending_wakes=0,wake_at=NULL,queued_at=NULL,updated_at=clock_timestamp() WHERE table_id=$1 AND row_id=$2`,
      [input.tableId, input.recordId],
    );
    await tx.client.query(
      `UPDATE ${relation(tx, 'tf_inbox_items')} SET resolved_at=clock_timestamp() WHERE table_id=$1 AND row_id=$2 AND resolved_at IS NULL`,
      [input.tableId, input.recordId],
    );
    return;
  }
  if (sameActor(previous, next)) return;
  if (next?.type === 'agent') {
    await tx.client.query(
      `INSERT INTO ${relation(tx, 'tf_row_assignments')} AS a(table_id,row_id,agent_id,sponsor_membership_id,generation,run_state,queued_at,pending_wakes)
       VALUES($1,$2,$3,$4,1,'queued',clock_timestamp(),1)
       ON CONFLICT(table_id,row_id) DO UPDATE SET agent_id=EXCLUDED.agent_id,sponsor_membership_id=EXCLUDED.sponsor_membership_id,
         generation=a.generation+1,run_state='queued',reason=NULL,wake_at=NULL,queued_at=clock_timestamp(),pending_wakes=1,updated_at=clock_timestamp()`,
      [input.tableId, input.recordId, next.id, writer!.membershipId],
    );
  } else {
    await tx.client.query(
      `UPDATE ${relation(tx, 'tf_row_assignments')} SET run_state='stopped',generation=generation+1,pending_wakes=0,wake_at=NULL,queued_at=NULL,reason=NULL,updated_at=clock_timestamp() WHERE table_id=$1 AND row_id=$2`,
      [input.tableId, input.recordId],
    );
  }
  await tx.client.query(
    `UPDATE ${relation(tx, 'tf_inbox_items')} SET resolved_at=clock_timestamp() WHERE table_id=$1 AND row_id=$2 AND kind IN ('assigned','waiting','finished') AND resolved_at IS NULL`,
    [input.tableId, input.recordId],
  );
  if (next?.type === 'member' && next.id !== (writer?.agentId ? null : writer?.membershipId))
    await tx.client.query(
      `INSERT INTO ${relation(tx, 'tf_inbox_items')}(id,membership_id,kind,table_id,row_id,source_id) VALUES($1,$2,'assigned',$3,$4,$5) ON CONFLICT DO NOTHING`,
      [randomUUID(), next.id, input.tableId, input.recordId, randomUUID()],
    );
  await threadEvent(tx, input, writer, {
    type: next ? (previous ? 'reassigned' : 'assigned') : 'unassigned',
    from: previous ? actorKey(previous) : null,
    to: next ? actorKey(next) : null,
  });
}
