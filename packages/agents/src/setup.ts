import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import {
  AccessDenied,
  canAccessAsset,
  requireNoMcpDerived,
  requireSharedMcpSlots,
  requireTaskInvocation,
  uuidSchema,
  type HumanActor,
} from '@tulipfarm/access';
import { canonicalJson } from '@tulipfarm/tables/canonical';
import { createAgentAuthoring } from './authoring.ts';
import { createSavedAgentService } from './saved-service.ts';
import { createAgentSchedules } from './schedules.ts';
import { createAgentStore, relation, type AgentStorage, type AgentTransaction } from './store.ts';
import { AgentError, agentCommandStatusSchema } from './saved-contracts.ts';
import { requireAgentCreation, requireAgentPermission, withHuman } from './saved-policy.ts';
import { resolveProcedures } from './workspace-skills.ts';
import { boundRuntime } from './task-approval-gate.ts';
import { requireCommandDraftSources } from './draft-sources.ts';
import type { ModelFamilyEligibility } from './model-policy-contracts.ts';
import {
  agentSetupDraftSchema,
  agentSetupReceiptSchema,
  publishAgentSetupSchema,
  saveAgentSetupDraftSchema,
  type AgentSetupDraft,
  type AgentSetupReceipt,
  type SaveAgentSetupDraft,
} from './setup-contracts.ts';

export type AgentSetupOptions = {
  attachSlack?:
    | ((
        transaction: AgentTransaction,
        workspaceId: string,
        userId: string,
        input: {
          channel: string;
          agentId: string | null;
          expectedVersion: number;
          replaceAgentId: string | null;
        },
      ) => Promise<{ version: number; channelResponses: boolean }>)
    | undefined;
  inspectSlack?:
    | ((
        transaction: AgentTransaction,
        workspaceId: string,
        userId: string,
        channel: string,
      ) => Promise<{
        agentId: string | null;
        version: number;
        channelResponses: boolean;
        occupied?: boolean;
      }>)
    | undefined;
};
const draftRowSchema = z.object({
  agent_id: uuidSchema,
  membership_id: uuidSchema,
  user_id: z.string(),
  version: z.number().int(),
  input: saveAgentSetupDraftSchema,
  digest: z.string(),
});
const commandRowSchema = z.object({
  id: uuidSchema,
  agent_id: uuidSchema,
  membership_id: uuidSchema,
  user_id: z.string(),
  version: z.number(),
  input: publishAgentSetupSchema,
  digest: z.string(),
  definition_command_id: uuidSchema,
  status: agentSetupReceiptSchema.shape.status,
  saved_revision: z.string().nullable(),
  activation_id: uuidSchema.nullable(),
  error: z.string().nullable(),
});
type Command = z.infer<typeof commandRowSchema>;
const installed = (tx: AgentTransaction & { commonVersion: number }) => {
  if (tx.commonVersion < 1) throw new AgentError('agent-setup-unavailable', 503);
};
const draftView = (row: z.infer<typeof draftRowSchema>): AgentSetupDraft => {
  const { requestId: _requestId, expectedVersion: _expectedVersion, ...input } = row.input;
  return agentSetupDraftSchema.parse({ agentId: row.agent_id, version: row.version, digest: row.digest, ...input });
};
const receipt = (row: Command): AgentSetupReceipt =>
  agentSetupReceiptSchema.parse({
    commandId: row.id,
    agentId: row.agent_id,
    version: row.version,
    digest: row.digest,
    status: row.status,
    savedRevision: row.saved_revision,
    activationId: row.activation_id,
    error: row.error,
  });
export function agentSetupDigest(agentId: string, input: SaveAgentSetupDraft) {
  const { requestId: _requestId, expectedVersion, ...reviewed } = input;
  return createHash('sha256')
    .update(canonicalJson({ agentId, version: expectedVersion + 1, ...reviewed }))
    .digest('hex');
}
export function agentSetupScheduleId(commandId: string, selectedId: string) {
  const hash = createHash('sha256').update(`${commandId}:${selectedId}`).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
function setupFailure(error: unknown) {
  if (error instanceof AgentError) return error.code;
  if (error instanceof AccessDenied) return 'setup-access-denied';
  if (
    error instanceof Error &&
    ['slack-attachment-conflict', 'slack-channel-delivery-disabled'].includes(error.message)
  )
    return error.message;
  return 'setup-operation-unavailable';
}
export function createAgentSetup(
  runtime: AgentStorage,
  eligible?: ModelFamilyEligibility,
  options: AgentSetupOptions = {},
) {
  async function authorize(
    tx: AgentTransaction,
    actor: HumanActor,
    agentId: string,
    input: SaveAgentSetupDraft,
    permission: 'read' | 'edit' | 'manage' = 'edit',
  ) {
    const current = (
      await tx.client.query(
        `SELECT saved_revision,owning_team_id,deleted_at FROM ${relation(tx, 'tf_agents')} WHERE id=$1`,
        [agentId],
      )
    ).rows[0];
    if (current?.deleted_at) throw new AccessDenied();
    if (current) await requireAgentPermission(tx, actor, agentId, permission);
    else await requireAgentCreation(tx, actor, input.setup.owningTeamId);
    await requireSharedMcpSlots(tx, input.setup.definition);
    await resolveProcedures(tx, input.setup.definition.skills, actor);
    await requireNoMcpDerived(
      tx,
      (input.setup.definition.skills ?? [])
        .filter(skill => uuidSchema.safeParse(skill.id).success)
        .map(skill => ({ kind: 'workspace-skill', skillId: skill.id, revision: skill.revision })),
    );
    return current;
  }
  async function loadDraft(tx: AgentTransaction, actor: HumanActor, agentId: string, version?: number) {
    const row = draftRowSchema
      .optional()
      .parse(
        (
          await tx.client.query(
            `SELECT * FROM ${relation(tx, 'tf_agent_setup_drafts')} WHERE agent_id=$1 AND membership_id=$2 AND user_id=$3 ${version === undefined ? 'ORDER BY version DESC LIMIT 1' : 'AND version=$4'}`,
            version === undefined
              ? [agentId, actor.membershipId, actor.userId]
              : [agentId, actor.membershipId, actor.userId, version],
          )
        ).rows[0],
      );
    if (!row) throw new AgentError('setup-draft-not-found', 404);
    return row;
  }
  async function saveDraft(workspaceId: string, user: string | HumanActor, agentIdInput: string, value: unknown) {
    const agentId = uuidSchema.parse(agentIdInput),
      input = saveAgentSetupDraftSchema.parse(value);
    return withHuman(runtime, workspaceId, user, 'write', async (tx, actor) => {
      installed(tx);
      await authorize(tx, actor, agentId, input);
      const previous = draftRowSchema
        .optional()
        .parse(
          (
            await tx.client.query(
              `SELECT * FROM ${relation(tx, 'tf_agent_setup_drafts')} WHERE membership_id=$1 AND request_id=$2`,
              [actor.membershipId, input.requestId],
            )
          ).rows[0],
        );
      if (previous) {
        if (previous.agent_id !== agentId || canonicalJson(previous.input) !== canonicalJson(input))
          throw new AgentError('idempotency-conflict');
        return draftView(previous);
      }
      const version = Number(
        (
          await tx.client.query(
            `SELECT COALESCE(max(version),0) AS version FROM ${relation(tx, 'tf_agent_setup_drafts')} WHERE agent_id=$1 AND membership_id=$2`,
            [agentId, actor.membershipId],
          )
        ).rows[0]?.version,
      );
      if (version !== input.expectedVersion) throw new AgentError('setup-version-conflict');
      const row = draftRowSchema.parse(
        (
          await tx.client.query(
            `INSERT INTO ${relation(tx, 'tf_agent_setup_drafts')} (agent_id,membership_id,user_id,version,request_id,input,digest) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
            [
              agentId,
              actor.membershipId,
              actor.userId,
              version + 1,
              input.requestId,
              input,
              agentSetupDigest(agentId, input),
            ],
          )
        ).rows[0],
      );
      return draftView(row);
    });
  }
  async function readDraft(workspaceId: string, user: string | HumanActor, agentId: string) {
    return withHuman(runtime, workspaceId, user, 'read', async (tx, actor) => {
      installed(tx);
      const row = await loadDraft(tx, actor, uuidSchema.parse(agentId));
      await authorize(tx, actor, row.agent_id, row.input, 'read');
      const command = (
        await tx.client.query(
          `SELECT id FROM ${relation(tx, 'tf_agent_setup_commands')} WHERE agent_id=$1 AND membership_id=$2 AND version=$3 ORDER BY created_at DESC,id DESC LIMIT 1`,
          [row.agent_id, actor.membershipId, row.version],
        )
      ).rows[0];
      return { ...draftView(row), commandId: command ? uuidSchema.parse(command.id) : null };
    });
  }
  async function loadCommand(tx: AgentTransaction, actor: HumanActor, commandId: string) {
    const command = commandRowSchema
      .optional()
      .parse(
        (
          await tx.client.query(
            `SELECT * FROM ${relation(tx, 'tf_agent_setup_commands')} WHERE id=$1 AND membership_id=$2 AND user_id=$3 FOR UPDATE`,
            [uuidSchema.parse(commandId), actor.membershipId, actor.userId],
          )
        ).rows[0],
      );
    if (!command) throw new AccessDenied();
    return command;
  }
  async function publish(workspaceId: string, user: string | HumanActor, agentIdInput: string, value: unknown) {
    const agentId = uuidSchema.parse(agentIdInput),
      input = publishAgentSetupSchema.parse(value);
    return withHuman(runtime, workspaceId, user, 'write', async (tx, actor) => {
      installed(tx);
      const draft = await loadDraft(tx, actor, agentId, input.version);
      if (draft.digest !== input.digest) throw new AgentError('setup-digest-conflict');
      const current = await authorize(
        tx,
        actor,
        agentId,
        draft.input,
        input.decision === 'activate' ? 'manage' : 'edit',
      );
      const previous = commandRowSchema
        .optional()
        .parse(
          (
            await tx.client.query(
              `SELECT * FROM ${relation(tx, 'tf_agent_setup_commands')} WHERE membership_id=$1 AND request_id=$2`,
              [actor.membershipId, input.requestId],
            )
          ).rows[0],
        );
      if (previous) {
        if (previous.agent_id !== agentId || canonicalJson(previous.input) !== canonicalJson(input))
          throw new AgentError('idempotency-conflict');
        return receipt(previous);
      }
      const latest = await loadDraft(tx, actor, agentId);
      if (latest.version !== input.version) throw new AgentError('setup-version-conflict');
      if (input.decision === 'activate') {
        for (const selected of draft.input.setup.schedules)
          if (
            selected.sponsorMembershipId !== actor.membershipId ||
            !input.consent.sponsorScheduleIds.includes(selected.id)
          )
            throw new AgentError('schedule-sponsor-consent-required', 400);
        for (const channel of draft.input.setup.slackChannels) {
          if (channel.detach && channel.replaceAgentId !== agentId) throw new AgentError('slack-detachment-conflict');
          if (
            channel.replaceAgentId &&
            channel.replaceAgentId !== agentId &&
            !input.consent.replaceChannels.includes(channel.channel)
          )
            throw new AgentError('slack-replacement-consent-required', 400);
        }
      }
      const bound = boundRuntime(tx, workspaceId);
      const earlier = commandRowSchema
        .optional()
        .parse(
          (
            await tx.client.query(
              `SELECT * FROM ${relation(tx, 'tf_agent_setup_commands')} WHERE agent_id=$1 AND membership_id=$2 AND version=$3 ORDER BY created_at,id LIMIT 1`,
              [agentId, actor.membershipId, input.version],
            )
          ).rows[0],
        );
      const definition = earlier
        ? await createAgentAuthoring(bound, eligible).commandStatus(workspaceId, actor, earlier.definition_command_id)
        : await createAgentAuthoring(bound, eligible).save(workspaceId, actor, agentId, {
            requestId: input.requestId,
            expectedSoulRevision: draft.input.expectedSoulRevision,
            expectedSavedRevision: draft.input.expectedSavedRevision,
            owningTeamId: current ? current.owning_team_id : draft.input.setup.owningTeamId,
            definition: draft.input.setup.definition,
          });
      const command = commandRowSchema.parse(
        (
          await tx.client.query(
            `INSERT INTO ${relation(tx, 'tf_agent_setup_commands')} (id,agent_id,membership_id,user_id,request_id,version,input,digest,definition_command_id,activation_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
            [
              randomUUID(),
              agentId,
              actor.membershipId,
              actor.userId,
              input.requestId,
              input.version,
              input,
              input.digest,
              definition.commandId,
              input.decision === 'activate' ? randomUUID() : null,
            ],
          )
        ).rows[0],
      );
      return receipt(command);
    });
  }
  async function apply(
    tx: AgentTransaction & { commonVersion: number },
    workspaceId: string,
    actor: HumanActor,
    command: Command,
    draft: AgentSetupDraft,
  ) {
    const current = (
      await tx.client.query(
        `SELECT policy_version,saved_revision,creator_id,EXISTS (SELECT 1 FROM ${relation(tx, 'tf_agent_activations')} WHERE agent_id=$1) AS previously_activated FROM ${relation(tx, 'tf_agents')} WHERE id=$1`,
        [command.agent_id],
      )
    ).rows[0];
    if (current?.saved_revision !== command.saved_revision) throw new AgentError('saved-revision-conflict');
    if (current.policy_version !== draft.expectedPolicyVersion) throw new AgentError('policy-version-conflict');
    const active = (
      await tx.client.query(
        `SELECT id FROM ${relation(tx, 'tf_agent_activations')} WHERE agent_id=$1 AND revoked_at IS NULL ORDER BY id`,
        [command.agent_id],
      )
    ).rows.map(row => uuidSchema.parse(row.id));
    if (canonicalJson(active) !== canonicalJson([...draft.expectedActivationIds].sort()))
      throw new AgentError('activation-version-conflict');
    const bound = boundRuntime(tx, workspaceId),
      { setup } = draft;
    for (const entry of [...setup.scope, ...setup.limits])
      for (const permission of entry.permissions) {
        if (!(await canAccessAsset(tx, actor, entry.assetId, permission))) throw new AccessDenied();
      }
    for (const entry of setup.scope)
      if (
        entry.permissions.some(
          permission =>
            !setup.limits.some(limit => limit.assetId === entry.assetId && limit.permissions.includes(permission)),
        )
      )
        throw new AgentError('activation-scope-exceeds-limits', 400);
    const service = createSavedAgentService(bound),
      store = createAgentStore(bound);
    // Saving a definition does not finish creation; retain its creator defaults until the first policy or activation change.
    const creating =
      current.creator_id === actor.membershipId &&
      current.policy_version === 0 &&
      current.previously_activated === false;
    const policy = creating
      ? {
          ...setup.policy,
          personGrants: [
            ...setup.policy.personGrants.filter(grant => grant.membershipId !== actor.membershipId),
            { membershipId: actor.membershipId, permissions: ['read', 'edit', 'delete', 'invoke', 'manage'] },
          ],
        }
      : setup.policy;
    await service.updatePolicy(workspaceId, actor.userId, command.agent_id, {
      ...policy,
      owningTeamId: setup.owningTeamId,
      version: draft.expectedPolicyVersion,
    });
    await store.configure(workspaceId, actor, {
      agentId: command.agent_id,
      version: draft.expectedPolicyVersion + 1,
      enabled: true,
      teamIds: setup.enrollment,
      limits: setup.limits,
      taskLimits: setup.taskLimits,
      slackSender: setup.slackSender,
    });
    const revision = z
      .string()
      .parse(
        (
          await tx.client.query(
            `SELECT definition_revision FROM ${relation(tx, 'tf_agent_saved_revisions')} WHERE agent_id=$1 AND soul_revision=$2`,
            [command.agent_id, command.saved_revision],
          )
        ).rows[0]?.definition_revision,
      );
    const activated = await store.activate(workspaceId, actor, {
      agentId: command.agent_id,
      revision,
      scope: setup.scope,
      requestId: command.activation_id,
    });
    for (const id of draft.expectedActivationIds)
      await store.revokeActivation(workspaceId, actor, { agentId: command.agent_id, activationId: id });
    for (const selected of setup.schedules) {
      await requireTaskInvocation(tx, actor, command.agent_id);
      await createAgentSchedules(bound).save(workspaceId, actor.userId, command.agent_id, {
        ...selected,
        id: agentSetupScheduleId(command.id, selected.id),
        activationId: activated.activationId,
        historyAudience: [],
      });
    }
    for (const selected of setup.slackChannels) {
      if (!options.attachSlack) throw new AgentError('slack-channel-setup-unavailable', 503);
      const attached = await options.attachSlack(tx, workspaceId, actor.userId, {
        channel: selected.channel,
        agentId: selected.detach ? null : command.agent_id,
        expectedVersion: selected.expectedVersion,
        replaceAgentId: selected.replaceAgentId,
      });
      if (!attached.channelResponses) throw new AgentError('slack-channel-delivery-unavailable', 503);
    }
  }
  async function advance(workspaceId: string, user: string | HumanActor, commandId: string) {
    return withHuman(runtime, workspaceId, user, 'write', async (tx, actor) => {
      installed(tx);
      let command = await loadCommand(tx, actor, commandId);
      const draft = await loadDraft(tx, actor, command.agent_id, command.version);
      await authorize(
        tx,
        actor,
        command.agent_id,
        draft.input,
        ['preparing', 'blocked'].includes(command.status)
          ? command.input.decision === 'activate'
            ? 'manage'
            : 'edit'
          : 'read',
      );
      await requireCommandDraftSources(tx, actor, command.definition_command_id);
      if (!['preparing', 'blocked'].includes(command.status)) return receipt(command);
      const definition = await createAgentAuthoring(boundRuntime(tx, workspaceId), eligible).commandStatus(
        workspaceId,
        actor,
        command.definition_command_id,
      );
      if (definition.status === 'preparing') return receipt(command);
      const saveStatus = definition.status === 'accepted' ? 'saved' : definition.status;
      command = {
        ...command,
        status: saveStatus,
        saved_revision: definition.savedRevision,
        error: saveStatus === 'saved' ? null : `definition-${saveStatus}`,
      };
      if (saveStatus === 'saved' && command.input.decision === 'activate') {
        // Soul acceptance is durable already. Only the database setup is rolled back on a recoverable failure.
        await tx.client.query('SAVEPOINT tf_agent_setup');
        try {
          await apply(tx, workspaceId, actor, command, draftView(draft));
          command.status = 'active';
          await tx.client.query('RELEASE SAVEPOINT tf_agent_setup');
        } catch (error) {
          await tx.client.query('ROLLBACK TO SAVEPOINT tf_agent_setup');
          await tx.client.query('RELEASE SAVEPOINT tf_agent_setup');
          command.status = 'blocked';
          command.error = setupFailure(error);
        }
      }
      await tx.client.query(
        `UPDATE ${relation(tx, 'tf_agent_setup_commands')} SET status=$2,saved_revision=$3,error=$4,updated_at=clock_timestamp() WHERE id=$1`,
        [command.id, command.status, command.saved_revision, command.error],
      );
      return receipt(command);
    });
  }
  async function readCommand(workspaceId: string, user: string | HumanActor, commandId: string) {
    return withHuman(runtime, workspaceId, user, 'read', async (tx, actor) => {
      installed(tx);
      const command = await loadCommand(tx, actor, commandId),
        draft = await loadDraft(tx, actor, command.agent_id, command.version);
      await authorize(tx, actor, command.agent_id, draft.input, 'read');
      await requireCommandDraftSources(tx, actor, command.definition_command_id);
      return receipt(command);
    });
  }
  async function definitionCommand(workspaceId: string, user: string | HumanActor, commandId: string) {
    return withHuman(runtime, workspaceId, user, 'read', async (tx, actor) => {
      installed(tx);
      const command = await loadCommand(tx, actor, commandId);
      return agentCommandStatusSchema.parse(
        await createAgentAuthoring(boundRuntime(tx, workspaceId), eligible).commandStatus(
          workspaceId,
          actor,
          command.definition_command_id,
        ),
      );
    });
  }
  async function pending(workspaceId: string) {
    return runtime.transaction(workspaceId, { minimum: 1, maximum: commonCompatibility.maximum }, async tx =>
      z
        .array(z.object({ id: uuidSchema, user_id: z.string() }))
        .parse(
          (
            await tx.client.query(
              `SELECT id,user_id FROM ${relation(tx, 'tf_agent_setup_commands')} WHERE status='preparing' ORDER BY created_at,id LIMIT 20`,
            )
          ).rows,
        ),
    );
  }
  return { saveDraft, readDraft, publish, advance, readCommand, definitionCommand, pending };
}
