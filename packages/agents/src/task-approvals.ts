import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AccessDenied, lockAuthorization, resolveHuman, uuidSchema, type HumanActor } from '@tulipfarm/access';
import { createAgentRecordTools } from './record-tools.ts';
import { canonicalJson } from '@tulipfarm/tables/canonical';
import { withMaintenanceTransaction } from '@tulipfarm/workspace-storage/provisioning';
import { createAgentStore, relation, type AgentStorage, type AgentTransaction } from './store.ts';
import { createAgentTasks } from './tasks.ts';
import { agentDefinitionSchema } from './contracts.ts';
import { resolveRunProcedures } from './workspace-skills.ts';
import {
  actionAuthority,
  actionFresh,
  boundRuntime,
  loadTaskProposal,
  lockTask,
  taskOutputAllowed,
} from './task-approval-gate.ts';
import {
  proposeTaskSchema,
  recoverTaskSchema,
  taskActionSchema,
  taskBatchStatusSchema,
  taskDecisionSchema,
  taskGenerationSchema,
  TaskApprovalError,
  TaskRecordConflict,
} from './task-approval-contracts.ts';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';

const digest = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
type Transaction = AgentTransaction & { commonVersion: number };
type AppliedDefinition = NonNullable<
  Awaited<ReturnType<ReturnType<typeof createAgentRecordTools>['status']>>['appliedDefinition']
>;
type ActionRecord = z.infer<typeof taskActionSchema>['before'];
// Only referenced options are stored: full option lists across 50 actions can exceed the 1 MiB proposal actions limit.
function actionFields(definition: AppliedDefinition, records: ActionRecord[]) {
  return definition.fields.map(field => {
    if (!('options' in field)) return { id: field.id, label: field.label };
    const used = new Set(
      records.flatMap(record => {
        const value = record?.values[field.id];
        return value?.kind === 'single-select'
          ? [value.optionId]
          : value?.kind === 'multi-select'
            ? value.optionIds
            : [];
      }),
    );
    return {
      id: field.id,
      label: field.label,
      options: field.options
        .filter(option => used.has(option.id))
        .map(option => ({ id: option.id, label: option.label })),
    };
  });
}

function actionId(proposalId: string, index: number) {
  const hash = digest([proposalId, index]);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
function taskApprovalOperations(runtime: AgentStorage) {
  async function owned<T>(
    workspaceId: string,
    userId: string,
    taskId: string,
    operation: (tx: Transaction, owner: HumanActor) => Promise<T>,
  ) {
    workspaceId = uuidSchema.parse(workspaceId);
    taskId = uuidSchema.parse(taskId);
    return runtime.transaction(workspaceId, commonCompatibility, async tx => {
      await lockAuthorization(tx);
      await lockTask(tx, taskId);
      const owner = await resolveHuman(tx, userId);
      if (
        !(
          await tx.client.query(
            `SELECT 1 FROM ${relation(tx, 'tf_agent_tasks')} WHERE id=$1 AND owner_user_id=$2 AND owner_membership_id=$3`,
            [taskId, owner.userId, owner.membershipId],
          )
        ).rowCount
      )
        throw new AccessDenied();
      return operation(tx, owner);
    });
  }
  async function generationRun(
    tx: Transaction,
    workspaceId: string,
    owner: HumanActor,
    taskId: string,
    generation: number,
  ) {
    taskId = uuidSchema.parse(taskId);
    const local = boundRuntime(tx, workspaceId);
    const task = await createAgentTasks(local).read(workspaceId, owner.userId, taskId);
    if (task.generation !== generation || !['pending', 'waiting-approval'].includes(task.status))
      throw new TaskApprovalError('task-run-conflict');
    const previous = (
      await tx.client.query(
        `SELECT run_id FROM ${relation(tx, 'tf_agent_task_runs')} WHERE task_id=$1 AND generation=$2`,
        [taskId, generation],
      )
    ).rows[0];
    let runId;
    if (previous) runId = uuidSchema.parse(previous.run_id);
    else {
      runId = (
        await createAgentStore(local).startTaskRun(
          workspaceId,
          owner,
          { activationId: task.activationId, scope: task.scope },
          { id: taskId, generation },
        )
      ).runId;
    }
    await resolveRunProcedures(tx, runId);
    await taskOutputAllowed(tx, workspaceId, runId, true);
    return runId;
  }
  async function statusIn(tx: AgentTransaction, taskId: string, proposalId: string) {
    const proposal = await loadTaskProposal(tx, proposalId);
    if (proposal.taskId !== taskId.toLowerCase()) throw new AccessDenied();
    const decision =
      (
        await tx.client.query(`SELECT decision FROM ${relation(tx, 'tf_agent_task_decisions')} WHERE proposal_id=$1`, [
          proposalId,
        ])
      ).rows[0]?.decision ?? null;
    const superseded = Boolean(
      (
        await tx.client.query(`SELECT 1 FROM ${relation(tx, 'tf_agent_task_supersessions')} WHERE proposal_id=$1`, [
          proposalId,
        ])
      ).rowCount,
    );
    const actions = [];
    for (const action of proposal.actions) {
      const row = (
        await tx.client.query(`SELECT status FROM ${relation(tx, 'tf_agent_task_action_receipts')} WHERE call_id=$1`, [
          action.id,
        ])
      ).rows[0];
      actions.push({
        id: action.id,
        status:
          row?.status === 'completed'
            ? 'completed'
            : row?.status === 'failed' || row?.status === 'blocked'
              ? 'failed'
              : 'unattempted',
      });
    }
    return taskBatchStatusSchema.parse({ id: proposalId, decision, superseded, actions });
  }
  async function viewIn(tx: Transaction, workspaceId: string, taskId: string, proposalId: string) {
    const proposal = await loadTaskProposal(tx, proposalId);
    if (proposal.taskId !== taskId.toLowerCase()) throw new AccessDenied();
    await taskOutputAllowed(tx, workspaceId, proposal.runId, false);
    return { ...proposal, status: await statusIn(tx, taskId, proposalId) };
  }
  async function proposeIn(
    tx: Transaction,
    workspaceId: string,
    owner: HumanActor,
    taskId: string,
    input: z.infer<typeof proposeTaskSchema>,
    recovery?: string,
    recoveryDigest?: string,
  ) {
    taskId = uuidSchema.parse(taskId);
    const inputDigest = digest({ ...input, recovery: recovery ?? null });
    const existing = (
      await tx.client.query(
        `SELECT id,input_digest FROM ${relation(tx, 'tf_agent_task_proposals')} WHERE task_id=$1 AND request_id=$2`,
        [taskId, input.requestId],
      )
    ).rows[0];
    if (existing) {
      if (existing.input_digest !== inputDigest) throw new TaskApprovalError('proposal-conflict');
      return viewIn(tx, workspaceId, taskId, uuidSchema.parse(existing.id));
    }
    const runId = await generationRun(tx, workspaceId, owner, taskId, input.generation);
    const open = await tx.client.query(
      `SELECT p.id FROM ${relation(tx, 'tf_agent_task_proposals')} p WHERE p.task_id=$1 AND NOT EXISTS (SELECT 1 FROM ${relation(tx, 'tf_agent_task_supersessions')} s WHERE s.proposal_id=p.id) AND NOT EXISTS (SELECT 1 FROM ${relation(tx, 'tf_agent_task_decisions')} d WHERE d.proposal_id=p.id AND d.decision='reject') AND EXISTS (SELECT 1 FROM jsonb_array_elements(p.actions) a LEFT JOIN ${relation(tx, 'tf_agent_tool_calls')} c ON c.id=(a->>'id')::uuid WHERE c.status IS DISTINCT FROM 'completed')`,
      [taskId],
    );
    if (open.rows.some(row => row.id !== recovery)) throw new TaskApprovalError('proposal-conflict');
    const resources = createAgentRecordTools(boundRuntime(tx, workspaceId));
    const definition = agentDefinitionSchema.parse(
      (
        await tx.client.query(
          `SELECT d.definition FROM ${relation(tx, 'tf_agent_runs')} r JOIN ${relation(tx, 'tf_agent_definitions')} d ON d.agent_id=r.agent_id AND d.revision=r.definition_revision WHERE r.id=$1`,
          [runId],
        )
      ).rows[0]?.definition,
    );
    const id = randomUUID(),
      actions = [],
      targets = new Set<string>(),
      conflicts = [];
    await resources.lockRecords(
      workspaceId,
      { kind: 'agent', runId },
      input.calls.map(call => call.tableId),
    );
    for (const [index, call] of input.calls.entries()) {
      if (!definition.tools.includes(call.tool)) throw new AccessDenied();
      const callId = actionId(id, index),
        recordId = call.tool === 'rows.create' ? callId : call.recordId;
      const key = `${call.tableId}/${recordId}`;
      if (targets.has(key)) throw new TaskApprovalError('proposal-conflict');
      targets.add(key);
      const actor = { kind: 'agent' as const, runId };
      const resource = await resources.status(workspaceId, actor, call.tableId);
      if (
        !resource.appliedDefinition ||
        resource.appliedRevision !== call.expectedAppliedRevision ||
        resource.maintenance
      )
        throw new TaskApprovalError('stale-proposal');
      const snapshot = await resources.recordSnapshot(
        workspaceId,
        actor,
        call.tableId,
        call.expectedAppliedRevision,
        recordId,
      );
      if (call.tool !== 'rows.create' && call.expectedToken !== snapshot.token) {
        conflicts.push(index);
        continue;
      }
      if (call.tool === 'rows.create' ? snapshot.record !== null : snapshot.record === null)
        throw new TaskApprovalError('stale-proposal');
      const after =
        call.tool === 'rows.delete'
          ? null
          : await resources.preview(
              workspaceId,
              actor,
              call.tableId,
              call.expectedAppliedRevision,
              recordId,
              call.tool === 'rows.create' ? 'create' : 'update',
              call.values,
            );
      const action = taskActionSchema.parse({
        id: callId,
        call,
        recordId,
        token: snapshot.token,
        before: snapshot.record,
        after,
        tableName: resource.name,
        fields: actionFields(resource.appliedDefinition, [snapshot.record, after]),
      });
      await actionAuthority(tx, owner, runId, action);
      actions.push(action);
    }
    if (conflicts.length) throw new TaskRecordConflict(conflicts);
    const proposal = { id, taskId, generation: input.generation, runId, actions };
    const proposalDigest = digest(proposal);
    await tx.client.query(
      `INSERT INTO ${relation(tx, 'tf_agent_task_proposals')} (id,task_id,generation,run_id,request_id,input_digest,digest,actions,recovery_digest) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        id,
        taskId,
        input.generation,
        runId,
        input.requestId,
        inputDigest,
        proposalDigest,
        JSON.stringify(actions),
        recoveryDigest ?? null,
      ],
    );
    const next = z
      .number()
      .parse(
        (
          await tx.client.query(
            `SELECT COALESCE(max(sequence)+1,0)::integer AS sequence FROM ${relation(tx, 'tf_agent_tool_calls')} WHERE run_id=$1`,
            [runId],
          )
        ).rows[0]?.sequence,
      );
    if (next + actions.length > 10000) throw new TaskApprovalError('task-run-conflict');
    for (const [index, action] of actions.entries())
      await tx.client.query(
        `INSERT INTO ${relation(tx, 'tf_agent_tool_calls')} (id,run_id,sequence,call) VALUES ($1,$2,$3,$4)`,
        [action.id, runId, next + index, action.call],
      );
    if (recovery)
      await tx.client.query(
        `INSERT INTO ${relation(tx, 'tf_agent_task_supersessions')} (proposal_id,successor_id) VALUES ($1,$2)`,
        [recovery, id],
      );
    return viewIn(tx, workspaceId, taskId, id);
  }
  return {
    list: (workspaceId: string, userId: string, taskId: string, after?: string) =>
      owned(workspaceId, userId, taskId, async tx => {
        const rows = z
          .array(z.object({ id: uuidSchema }))
          .parse(
            (
              await tx.client.query(
                `SELECT id FROM ${relation(tx, 'tf_agent_task_proposals')} WHERE task_id=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT 26`,
                [taskId, after ? uuidSchema.parse(after) : null],
              )
            ).rows,
          );
        const proposals = [];
        for (const row of rows.slice(0, 25)) proposals.push(await statusIn(tx, taskId, row.id));
        return { proposals, nextCursor: rows.length > 25 ? (proposals.at(-1)?.id ?? null) : null };
      }),
    bindRun: (workspaceId: string, userId: string, taskId: string, value: unknown) =>
      owned(workspaceId, userId, taskId, async (tx, owner) => ({
        runId: await generationRun(tx, workspaceId, owner, taskId, taskGenerationSchema.parse(value).generation),
      })),
    propose: (workspaceId: string, userId: string, taskId: string, value: unknown) =>
      owned(workspaceId, userId, taskId, (tx, owner) =>
        proposeIn(tx, workspaceId, owner, taskId, proposeTaskSchema.parse(value)),
      ),
    read: (workspaceId: string, userId: string, taskId: string, proposalId: string) =>
      owned(workspaceId, userId, taskId, tx => viewIn(tx, workspaceId, taskId, uuidSchema.parse(proposalId))),
    status: (workspaceId: string, userId: string, taskId: string, proposalId: string) =>
      owned(workspaceId, userId, taskId, tx => statusIn(tx, taskId, uuidSchema.parse(proposalId))),
    recover: (workspaceId: string, userId: string, taskId: string, proposalId: string, value: unknown) =>
      owned(workspaceId, userId, taskId, async (tx, owner) => {
        const input = recoverTaskSchema.parse(value);
        const proposal = await loadTaskProposal(tx, uuidSchema.parse(proposalId));
        const status = await statusIn(tx, taskId, proposal.id);
        const existing = (
          await tx.client.query(
            `SELECT successor_id FROM ${relation(tx, 'tf_agent_task_supersessions')} WHERE proposal_id=$1`,
            [proposal.id],
          )
        ).rows[0];
        if (existing) {
          const command = (
            await tx.client.query(
              `SELECT request_id,recovery_digest FROM ${relation(tx, 'tf_agent_task_proposals')} WHERE id=$1`,
              [existing.successor_id],
            )
          ).rows[0];
          if (command?.request_id !== input.requestId || command.recovery_digest !== digest(input))
            throw new TaskApprovalError('proposal-conflict');
          return viewIn(tx, workspaceId, taskId, uuidSchema.parse(existing.successor_id));
        }
        const resources = createAgentRecordTools(boundRuntime(tx, workspaceId));
        if (proposal.generation !== input.generation || status.actions.every(action => action.status === 'completed'))
          throw new TaskApprovalError('recovery-empty');
        if (input.calls) {
          const completed = z
            .array(z.object({ action: taskActionSchema }))
            .parse(
              (
                await tx.client.query(
                  `SELECT a AS action FROM ${relation(tx, 'tf_agent_task_proposals')} p CROSS JOIN LATERAL jsonb_array_elements(p.actions) a JOIN ${relation(tx, 'tf_agent_task_action_receipts')} r ON r.call_id=(a->>'id')::uuid AND r.status='completed' WHERE p.task_id=$1 AND p.generation=$2`,
                  [taskId, input.generation],
                )
              ).rows,
            );
          const completedTargets = new Set(completed.map(({ action }) => `${action.call.tableId}/${action.recordId}`));
          if (
            input.calls.some(
              call => call.tool !== 'rows.create' && completedTargets.has(`${call.tableId}/${call.recordId}`),
            )
          )
            throw new TaskApprovalError('proposal-conflict');
          return proposeIn(tx, workspaceId, owner, taskId, proposeTaskSchema.parse(input), proposal.id, digest(input));
        }
        const calls = [];
        for (const action of proposal.actions) {
          if (status.actions.some(item => item.id === action.id && item.status === 'completed')) continue;
          const actor = { kind: 'agent' as const, runId: proposal.runId };
          const current = await resources.status(workspaceId, actor, action.call.tableId);
          if (!current.appliedRevision) throw new TaskApprovalError('stale-proposal');
          if (action.call.tool === 'rows.create') {
            calls.push({ ...action.call, expectedAppliedRevision: current.appliedRevision });
            continue;
          }
          // The owner recovers without an agent read, so the refreshed proposal pins the row as it is now and shows that to the owner.
          const snapshot = await resources.recordSnapshot(
            workspaceId,
            actor,
            action.call.tableId,
            current.appliedRevision,
            action.recordId,
          );
          if (!snapshot.record || !snapshot.token) throw new TaskApprovalError('stale-proposal');
          calls.push({
            ...action.call,
            expectedAppliedRevision: current.appliedRevision,
            expectedToken: snapshot.token,
          });
        }
        if (!calls.length) throw new TaskApprovalError('recovery-empty');
        return proposeIn(
          tx,
          workspaceId,
          owner,
          taskId,
          proposeTaskSchema.parse({ ...input, calls }),
          proposal.id,
          digest(input),
        );
      }),
    async decide(
      workspaceId: string,
      userId: string,
      taskId: string,
      proposalId: string,
      value: unknown,
      recordDecision: (input: {
        proposalId: string;
        digest: string;
        membershipId: string;
        decision: 'approve' | 'reject';
      }) => Promise<void>,
    ) {
      const input = taskDecisionSchema.parse(value);
      return owned(workspaceId, userId, taskId, async (tx, owner) => {
        const proposal = await loadTaskProposal(tx, uuidSchema.parse(proposalId));
        if (proposal.taskId !== taskId.toLowerCase()) throw new AccessDenied();
        if (proposal.digest !== input.digest) throw new TaskApprovalError('proposal-conflict');
        const status = await statusIn(tx, taskId, proposal.id);
        if (status.decision) {
          if (status.decision !== input.decision) throw new TaskApprovalError('proposal-conflict');
          return status;
        }
        if (status.superseded) throw new TaskApprovalError('proposal-conflict');
        if (input.decision === 'approve') {
          await resolveRunProcedures(tx, proposal.runId);
          await taskOutputAllowed(tx, workspaceId, proposal.runId, true);
          await createAgentRecordTools(boundRuntime(tx, workspaceId)).lockRecords(
            workspaceId,
            { kind: 'agent', runId: proposal.runId },
            proposal.actions.map(action => action.call.tableId),
          );
          for (const action of proposal.actions) {
            await actionAuthority(tx, owner, proposal.runId, action);
            await actionFresh(tx, workspaceId, proposal.runId, action);
          }
        }
        await recordDecision({
          proposalId: proposal.id,
          digest: proposal.digest,
          membershipId: owner.membershipId,
          decision: input.decision,
        });
        return { ...status, decision: input.decision };
      });
    },
  };
}

export function createTaskApprovals(runtime: AgentStorage) {
  const { decide: _decide, ...operations } = taskApprovalOperations(runtime);
  return operations;
}

export function createTaskApprovalDecision(options: {
  runtime: AgentStorage;
  resolveConfirmationCredential: (workspaceId: string) => Promise<string>;
}) {
  const service = taskApprovalOperations(options.runtime);
  return (workspaceId: string, userId: string, taskId: string, proposalId: string, input: unknown) =>
    service.decide(workspaceId, userId, taskId, proposalId, input, async decision => {
      const connectionString = await options.resolveConfirmationCredential(workspaceId);
      await withMaintenanceTransaction({
        connectionString,
        workspaceId,
        capability: 'confirmation',
        operation: async tx => {
          const match = await tx.client.query(
            `SELECT 1 FROM ${relation(tx, 'tf_agent_task_proposals')} p JOIN ${relation(tx, 'tf_agent_tasks')} t ON t.id=p.task_id WHERE p.id=$1 AND p.digest=$2 AND t.owner_membership_id=$3 AND t.generation=p.generation`,
            [decision.proposalId, decision.digest, decision.membershipId],
          );
          if (!match.rowCount) throw new AccessDenied();
          await tx.client.query(
            `INSERT INTO ${relation(tx, 'tf_agent_task_decisions')} (proposal_id,digest,membership_id,decision) VALUES ($1,$2,$3,$4)`,
            [decision.proposalId, decision.digest, decision.membershipId, decision.decision],
          );
        },
      });
    });
}
