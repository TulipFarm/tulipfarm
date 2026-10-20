import { z } from 'zod';
import {
  AccessDenied,
  currentMember,
  lockAuthorization,
  type AuthorizationTransaction,
  type HumanActor,
} from '@tulipfarm/access';
import {
  McpError,
  mcpSelectionSubjectSchema,
  mcpToolSchema,
  type WorkspaceMcpOptions,
  type McpPrincipal,
  type McpSelectionSubject,
  type McpSelectionAuthority,
} from './contracts.ts';
import { bindingsSchema, selectionSchema, table, type McpStore } from './store.ts';

const key = (subject: McpSelectionSubject) => `${subject.kind}:${subject.id}`;
const storedSchema = selectionSchema.extend({
  subject: mcpSelectionSubjectSchema.nullable(),
  claimed_task_id: z.uuid().nullable(),
});
export function selectionMethods(options: WorkspaceMcpOptions, store: McpStore) {
  async function authorize(tx: AuthorizationTransaction, actor: HumanActor, subject: McpSelectionSubject) {
    if (!options.authorizeSelection) throw new AccessDenied();
    const authority = await options.authorizeSelection({ transaction: tx, actor, subject });
    await store.sources(tx, actor, authority.sources);
    if (subject.kind !== 'chat' && !Array.isArray(authority.slots)) throw new AccessDenied();
    return authority;
  }
  async function load(tx: AuthorizationTransaction, actor: HumanActor, subject: McpSelectionSubject) {
    const value = storedSchema
      .optional()
      .parse(
        (
          await tx.client.query(
            `SELECT version,bindings,subject,claimed_task_id FROM ${table(tx, 'selections')} WHERE membership_id=$1 AND origin_key=$2`,
            [actor.membershipId, key(subject)],
          )
        ).rows[0],
      );
    if (
      value?.subject?.kind === 'task-draft' &&
      subject.kind === 'task-draft' &&
      value.subject.agentId !== subject.agentId
    )
      throw new McpError('conflict');
    return value ?? { version: 0, bindings: [], subject, claimed_task_id: null };
  }
  async function validate(
    tx: AuthorizationTransaction,
    actor: HumanActor,
    subject: McpSelectionSubject,
    authority: McpSelectionAuthority,
    bindings: z.infer<typeof bindingsSchema>,
  ) {
    const slots = new Set();
    for (const binding of bindings) {
      const row = await store.load(tx, binding.integrationId);
      await store.permit(tx, actor, row, 'use');
      store.active(row);
      if (row.authorization_epoch !== binding.authorizationEpoch) throw new AccessDenied();
      if (subject.kind === 'chat') {
        if (binding.slotId) throw new McpError('invalid-input');
        continue;
      }
      const slot = authority.slots?.find(slot => slot.slotId === binding.slotId);
      if (
        !slot ||
        slots.has(slot.slotId) ||
        slot.serverIdentity !== row.server_identity ||
        (slot.integrationId && (slot.integrationId !== row.id || row.ownership !== 'shared')) ||
        (row.ownership === 'personal' && !row.descriptor_approved)
      )
        throw new AccessDenied();
      slots.add(slot.slotId);
      for (const tool of slot.tools)
        if (
          !(
            await tx.client.query(
              `SELECT 1 FROM ${table(tx, 'tool_policies')} WHERE integration_id=$1 AND name=$2 AND discovered_revision=$3 AND enabled_revision=$3 AND present`,
              [row.id, tool.name, tool.revision],
            )
          ).rowCount
        )
          throw new AccessDenied();
    }
  }
  return {
    selectionFor(workspaceId: string, principal: McpPrincipal, input: McpSelectionSubject) {
      const subject = mcpSelectionSubjectSchema.parse(input);
      return store.authorized(workspaceId, principal, async (tx, actor) => {
        const authority = await authorize(tx, actor, subject);
        const value = await load(tx, actor, subject);
        let stale = false;
        try {
          await validate(tx, actor, subject, authority, value.bindings);
        } catch (error) {
          if (!(error instanceof AccessDenied) && !(error instanceof McpError)) throw error;
          stale = true;
        }
        return { version: value.version, bindings: value.bindings, claimedTaskId: value.claimed_task_id, stale };
      });
    },
    selectFor(workspaceId: string, principal: McpPrincipal, input: unknown) {
      if (!options.dispatchEnabled) throw new McpError('disabled');
      const value = z
        .strictObject({
          origin: mcpSelectionSubjectSchema,
          requestId: z.uuid(),
          expectedVersion: z.number().int().nonnegative(),
          bindings: z
            .array(z.strictObject({ integrationId: z.uuid(), slotId: z.string().max(200).nullable() }))
            .max(20),
        })
        .parse(input);
      return store.authorized(workspaceId, principal, async (tx, actor) => {
        const authority = await authorize(tx, actor, value.origin);
        const result = await store.command(
          tx,
          actor,
          value.requestId,
          'selection',
          value,
          selectionSchema,
          async () => {
            const old = await load(tx, actor, value.origin);
            if (old.version !== value.expectedVersion || old.claimed_task_id) throw new McpError('conflict');
            const bindings = [];
            for (const binding of value.bindings) {
              const row = await store.load(tx, binding.integrationId);
              bindings.push({ ...binding, authorizationEpoch: row.authorization_epoch });
            }
            if (new Set(bindings.map(binding => `${binding.integrationId}:${binding.slotId}`)).size !== bindings.length)
              throw new McpError('invalid-input');
            await validate(tx, actor, value.origin, authority, bindings);
            await tx.client.query(
              `INSERT INTO ${table(tx, 'selections')} (membership_id,origin_key,version,bindings,subject) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (membership_id,origin_key) DO UPDATE SET version=EXCLUDED.version,bindings=EXCLUDED.bindings`,
              [actor.membershipId, key(value.origin), old.version + 1, JSON.stringify(bindings), value.origin],
            );
            return { version: old.version + 1, bindings };
          },
        );
        await validate(tx, actor, value.origin, authority, result.bindings);
        return result;
      });
    },
    async claimTaskSelection(
      transaction: AuthorizationTransaction,
      actor: HumanActor,
      input: { selectionId: string; version: number; taskId: string; agentId: string },
    ) {
      if (!options.dispatchEnabled) throw new McpError('disabled');
      const value = z
        .strictObject({
          selectionId: z.uuid(),
          version: z.number().int().positive(),
          taskId: z.uuid(),
          agentId: z.uuid(),
        })
        .parse(input);
      await lockAuthorization(transaction, 'write');
      await currentMember(transaction, actor);
      const draft = mcpSelectionSubjectSchema.parse({
        kind: 'task-draft',
        id: value.selectionId,
        agentId: value.agentId,
      });
      const authority = await authorize(transaction, actor, draft);
      const old = await load(transaction, actor, draft);
      if (old.version !== value.version || (old.claimed_task_id && old.claimed_task_id !== value.taskId))
        throw new McpError('conflict');
      await validate(transaction, actor, draft, authority, old.bindings);
      if (old.claimed_task_id === value.taskId) return { version: value.version, bindings: old.bindings };
      const task = mcpSelectionSubjectSchema.parse({ kind: 'task', id: value.taskId });
      await txTaskGuard(transaction, value.taskId, actor, value.agentId);
      const taskAuthority = await authorize(transaction, actor, task);
      await validate(transaction, actor, task, taskAuthority, old.bindings);
      await txInsert(transaction, actor, task, value.version, old.bindings);
      await transaction.client.query(
        `UPDATE ${table(transaction, 'selections')} SET claimed_task_id=$3 WHERE membership_id=$1 AND origin_key=$2`,
        [actor.membershipId, key(draft), value.taskId],
      );
      return { version: value.version, bindings: old.bindings };
    },
    async reviewedDescriptors(workspaceId: string, principal: McpPrincipal) {
      return store.authorized(workspaceId, principal, async (tx, actor) => {
        const ids = z
          .array(z.object({ id: z.uuid() }))
          .parse(
            (
              await tx.client.query(
                `SELECT id FROM ${table(tx, 'integrations')} WHERE lifecycle='active' AND (ownership='shared' OR (owner_membership_id=$1 AND descriptor_approved))`,
                [actor.membershipId],
              )
            ).rows,
          );
        const result = [];
        for (const { id } of ids) {
          const row = await store.load(tx, id);
          if (!(await store.capabilities(tx, actor, row)).read) continue;
          const tools = z
            .array(z.object({ name: z.string(), revision: z.string(), tool: mcpToolSchema }))
            .parse(
              (
                await tx.client.query(
                  `SELECT p.name,p.enabled_revision AS revision,r.tool FROM ${table(tx, 'tool_policies')} p JOIN ${table(tx, 'tool_revisions')} r ON r.integration_id=p.integration_id AND r.name=p.name AND r.revision=p.enabled_revision WHERE p.integration_id=$1 AND p.present AND p.enabled_revision=p.discovered_revision AND r.compatibility_reason IS NULL`,
                  [id],
                )
              ).rows,
            );
          result.push({
            serverIdentity: row.server_identity,
            ...(row.ownership === 'shared' ? { integrationId: id } : {}),
            tools: tools.map(tool => ({ name: tool.name, revision: tool.revision })),
          });
        }
        return result;
      });
    },
  };
}
async function txTaskGuard(tx: AuthorizationTransaction, taskId: string, actor: HumanActor, agentId: string) {
  const { qualified } = await import('@tulipfarm/workspace-storage/runtime');
  if (
    !(
      await tx.client.query(
        `SELECT 1 FROM ${qualified(tx.schema, 'tf_agent_tasks')} WHERE id=$1 AND owner_membership_id=$2 AND owner_user_id=$3 AND agent_id=$4`,
        [taskId, actor.membershipId, actor.userId, agentId],
      )
    ).rowCount
  )
    throw new AccessDenied();
}
async function txInsert(
  tx: AuthorizationTransaction,
  actor: HumanActor,
  subject: McpSelectionSubject,
  version: number,
  bindings: z.infer<typeof bindingsSchema>,
) {
  await tx.client.query(
    `INSERT INTO ${table(tx, 'selections')} (membership_id,origin_key,version,bindings,subject) VALUES ($1,$2,$3,$4,$5)`,
    [actor.membershipId, key(subject), version, JSON.stringify(bindings), subject],
  );
}
