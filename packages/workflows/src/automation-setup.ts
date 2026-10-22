import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AccessDenied, type HumanActor } from '@tulipfarm/access';
import { commonTables, qualified, StorageUnavailableError } from '@tulipfarm/workspace-storage/runtime';
import { canonical } from '@tulipfarm/workflow-snippets/canonical';
import {
  auditWorkflow,
  hasGrant,
  requireGrant,
  requireSponsor,
  workflowMember,
  workflowTransaction,
  type WorkflowTransaction,
} from './authorization.ts';
import { administrativeCommand, administrativeReplay, WorkflowConflict } from './commands.ts';
import { idSchema } from './contracts.ts';
import type { WorkflowRuntime } from './service.ts';
import {
  automationApprovalSchema,
  automationDecisionReceiptSchema,
  automationDecisionSchema,
  automationDraftInputSchema,
  automationDraftViewSchema,
  automationRevokeSchema,
  automationSetupSchema,
  type AutomationSetup,
} from './automation-contracts.ts';
import { automationApprovalDigest } from './automation.ts';

export type AutomationVerification = {
  source(
    workspaceId: string,
    actor: HumanActor,
    setup: AutomationSetup,
    privateRepositoryExport: boolean,
  ): Promise<void>;
  destination(workspaceId: string, actor: HumanActor, setup: AutomationSetup): Promise<void>;
};
const draftRowSchema = z.object({
  workflow_id: idSchema,
  revision: idSchema,
  membership_id: idSchema,
  version: z.number().int().positive(),
  setup: automationSetupSchema,
  digest: z.string().regex(/^[a-f0-9]{64}$/),
});
type Draft = z.infer<typeof draftRowSchema>;
const table = (tx: WorkflowTransaction, name: string) => qualified(tx.schema, name);

function draftDigest(workspaceId: string, membershipId: string, input: z.infer<typeof automationDraftInputSchema>) {
  return createHash('sha256')
    .update(
      canonical({
        policy: 'workflow-automation-draft/v1',
        workspaceId,
        membershipId,
        workflowId: input.workflowId,
        revision: input.expectedRevision,
        version: input.expectedVersion + 1,
        setup: input.setup,
      }),
    )
    .digest('hex');
}

export function createAutomationSetup(runtime: WorkflowRuntime, verification: AutomationVerification) {
  function transaction<T>(
    workspaceId: string,
    userId: string,
    operation: (tx: WorkflowTransaction, actor: HumanActor) => Promise<T>,
  ) {
    return workflowTransaction(runtime, workspaceId, async tx => {
      if (tx.commonVersion < 1) throw new StorageUnavailableError('incompatible_version');
      return operation(tx, await workflowMember(tx, userId));
    });
  }
  async function source(tx: WorkflowTransaction, actor: HumanActor, setup: AutomationSetup, sharing = false) {
    const found = (
      await tx.client.query(
        `SELECT s.generation FROM ${table(tx, commonTables.githubEventSources)} s
      JOIN ${table(tx, 'tf_memberships')} m ON m.id=s.membership_id AND m.removed_at IS NULL
      WHERE s.id=$1 AND s.status='active'
        AND EXISTS (SELECT 1 FROM ${table(tx, commonTables.githubEventSourceGrants)} g
          WHERE g.source_id=s.id AND g.membership_id=$2 AND g.permission='use')
        AND (NOT $3::boolean OR EXISTS (SELECT 1 FROM ${table(tx, commonTables.githubEventSourceGrants)} g
          WHERE g.source_id=s.id AND g.membership_id=$2 AND g.permission='share'))`,
        [setup.source.sourceId, actor.membershipId, sharing],
      )
    ).rows[0];
    if (!found) throw new AccessDenied();
    if (z.number().int().parse(found.generation) !== setup.source.generation)
      throw new WorkflowConflict('automation-source-stale');
  }
  async function destination(tx: WorkflowTransaction, setup: AutomationSetup) {
    const target = setup.destination;
    const found = await tx.client.query(
      `SELECT 1 FROM ${table(tx, 'tf_slack_destinations')} d
      JOIN ${table(tx, 'tf_slack_installations')} i ON i.id=d.installation_id AND i.generation=d.generation AND i.state='active'
      WHERE d.id=$1 AND d.installation_id=$2 AND d.generation=$3 AND d.version=$4 AND d.channel=$5 AND d.enabled`,
      [target.destinationId, target.installationId, target.generation, target.version, target.channelId],
    );
    if (!found.rowCount) throw new WorkflowConflict('automation-destination-stale');
  }
  async function currentRevision(tx: WorkflowTransaction, workflowId: string, revision: string) {
    const row = (
      await tx.client.query(`SELECT revision,archived_at FROM ${table(tx, 'tf_workflows')} WHERE id=$1`, [workflowId])
    ).rows[0];
    if (!row || row.archived_at !== null) throw new AccessDenied();
    if (row.revision !== revision) throw new WorkflowConflict('automation-revision-stale');
  }
  async function approvalAuthority(tx: WorkflowTransaction, actor: HumanActor, draft: Draft) {
    await currentRevision(tx, draft.workflow_id, draft.revision);
    await requireGrant(tx, actor.membershipId, draft.workflow_id, 'manage');
    const sponsor = await requireSponsor(tx, draft.workflow_id, draft.revision);
    if (sponsor.sponsor_membership_id !== actor.membershipId) throw new AccessDenied();
    await source(tx, actor, draft.setup, true);
    await destination(tx, draft.setup);
    return sponsor;
  }
  async function loadDraft(tx: WorkflowTransaction, actor: HumanActor, workflowId: string, version?: number) {
    const result = await tx.client.query(
      `SELECT * FROM ${table(tx, commonTables.workflowAutomationDrafts)}
      WHERE workflow_id=$1 AND membership_id=$2 ${version === undefined ? 'ORDER BY version DESC LIMIT 1' : 'AND version=$3'}`,
      version === undefined ? [workflowId, actor.membershipId] : [workflowId, actor.membershipId, version],
    );
    return draftRowSchema.optional().parse(result.rows[0]);
  }
  async function loadDecision(tx: WorkflowTransaction, draft: Draft) {
    const result = await tx.client.query(
      `SELECT d.command_id AS "commandId",d.workflow_id AS "workflowId",d.version,d.digest,
      d.decision,d.private_repository_export AS "privateRepositoryExport",d.grant_id AS "grantId",g.digest AS "grantDigest"
      FROM ${table(tx, commonTables.workflowAutomationDecisions)} d
      LEFT JOIN ${table(tx, commonTables.workflowAutomationGrants)} g ON g.id=d.grant_id
      WHERE d.workflow_id=$1 AND d.membership_id=$2 AND d.version=$3`,
      [draft.workflow_id, draft.membership_id, draft.version],
    );
    return automationDecisionReceiptSchema.optional().parse(result.rows[0]) ?? null;
  }
  async function view(tx: WorkflowTransaction, draft: Draft) {
    const decision = await loadDecision(tx, draft);
    const grant = decision?.grantId
      ? (
          await tx.client.query(
            `SELECT revoked_at FROM ${table(tx, commonTables.workflowAutomationGrants)}
      WHERE id=$1`,
            [decision.grantId],
          )
        ).rows[0]
      : null;
    const revokedAt = grant ? z.date().nullable().parse(grant.revoked_at) : null;
    return automationDraftViewSchema.parse({
      workflowId: draft.workflow_id,
      revision: draft.revision,
      membershipId: draft.membership_id,
      version: draft.version,
      setup: draft.setup,
      digest: draft.digest,
      decision,
      grantRevokedAt: revokedAt?.toISOString() ?? null,
    });
  }
  async function saveDraft(workspaceId: string, userId: string, value: unknown) {
    const input = automationDraftInputSchema.parse(value);
    return transaction(workspaceId, userId, async (tx, actor) => {
      await requireGrant(tx, actor.membershipId, input.workflowId, 'manage');
      await source(tx, actor, input.setup);
      const digest = draftDigest(workspaceId, actor.membershipId, input);
      const previous = draftRowSchema
        .optional()
        .parse(
          (
            await tx.client.query(
              `SELECT * FROM ${table(tx, commonTables.workflowAutomationDrafts)} WHERE membership_id=$1 AND command_id=$2`,
              [actor.membershipId, input.commandId],
            )
          ).rows[0],
        );
      if (previous) {
        if (previous.digest !== digest) throw new WorkflowConflict('command-conflict');
        return view(tx, previous);
      }
      await currentRevision(tx, input.workflowId, input.expectedRevision);
      const latest = await loadDraft(tx, actor, input.workflowId);
      if ((latest?.version ?? 0) !== input.expectedVersion) throw new WorkflowConflict('automation-draft-stale');
      const row = draftRowSchema.parse(
        (
          await tx.client.query(
            `INSERT INTO ${table(tx, commonTables.workflowAutomationDrafts)}
        (workflow_id,revision,membership_id,version,command_id,setup,digest) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
            [
              input.workflowId,
              input.expectedRevision,
              actor.membershipId,
              input.expectedVersion + 1,
              input.commandId,
              input.setup,
              digest,
            ],
          )
        ).rows[0],
      );
      await auditWorkflow(tx, actor.userId, 'workflow.automation.draft', input.workflowId);
      return view(tx, row);
    });
  }
  async function readDraft(workspaceId: string, userId: string, workflowIdInput: string) {
    const workflowId = idSchema.parse(workflowIdInput);
    return transaction(workspaceId, userId, async (tx, actor) => {
      await requireGrant(tx, actor.membershipId, workflowId, 'manage');
      const draft = await loadDraft(tx, actor, workflowId);
      if (!draft) return null;
      await source(tx, actor, draft.setup);
      return view(tx, draft);
    });
  }
  async function decide(workspaceId: string, userId: string, workflowIdInput: string, value: unknown) {
    const workflowId = idSchema.parse(workflowIdInput),
      input = automationDecisionSchema.parse(value);
    const command = (actor: HumanActor, generation: number) => ({
      commandId: input.commandId,
      expectedGeneration: input.version,
      generation,
      membershipId: actor.membershipId,
      operation: 'workflow.automation.decide',
      target: workflowId,
      request: input,
    });
    const prepared = await transaction(workspaceId, userId, async (tx, actor) => {
      await requireGrant(tx, actor.membershipId, workflowId, 'manage');
      const draft = await loadDraft(tx, actor, workflowId, input.version),
        latest = await loadDraft(tx, actor, workflowId);
      if (!draft || !latest) throw new AccessDenied();
      if (await administrativeReplay(tx, command(actor, latest.version))) {
        const receipt = await loadDecision(tx, draft);
        if (!receipt) throw new WorkflowConflict('automation-receipt-missing');
        return { kind: 'replay', receipt } as const;
      }
      if (draft.digest !== input.digest) throw new WorkflowConflict('automation-digest-conflict');
      if (await loadDecision(tx, draft)) throw new WorkflowConflict('automation-already-reviewed');
      const sponsor = input.decision === 'approve' ? await approvalAuthority(tx, actor, draft) : null;
      return { kind: 'review', actor, draft, sponsorshipId: sponsor?.sponsorship_id ?? null } as const;
    });
    if (prepared.kind === 'replay') return prepared.receipt;
    if (input.decision === 'approve') {
      await verification.source(workspaceId, prepared.actor, prepared.draft.setup, input.privateRepositoryExport);
      await verification.destination(workspaceId, prepared.actor, prepared.draft.setup);
    }
    return transaction(workspaceId, userId, async (tx, actor) => {
      await requireGrant(tx, actor.membershipId, workflowId, 'manage');
      const draft = await loadDraft(tx, actor, workflowId, input.version),
        latest = await loadDraft(tx, actor, workflowId);
      if (!draft || !latest) throw new AccessDenied();
      await administrativeCommand(tx, command(actor, latest.version), async () => {
        if (draft.digest !== input.digest) throw new WorkflowConflict('automation-digest-conflict');
        if (await loadDecision(tx, draft)) throw new WorkflowConflict('automation-already-reviewed');
        const grantId = input.decision === 'approve' ? randomUUID() : null;
        if (input.decision === 'approve') {
          const sponsor = await approvalAuthority(tx, actor, draft);
          if (sponsor.sponsorship_id !== prepared.sponsorshipId)
            throw new WorkflowConflict('automation-sponsorship-stale');
          const approval = automationApprovalSchema.parse({
            workflowId,
            revision: draft.revision,
            sponsorMembershipId: actor.membershipId,
            sponsorshipId: sponsor.sponsorship_id,
            setup: draft.setup,
            sharing: {
              approvedByMembershipId: actor.membershipId,
              sourceGeneration: draft.setup.source.generation,
              privateRepositoryExport: input.privateRepositoryExport,
            },
          });
          const target = draft.setup.destination;
          await tx.client.query(
            `UPDATE ${table(tx, commonTables.workflowAutomationGrants)} SET revoked_at=clock_timestamp()
            WHERE workflow_id=$1 AND revoked_at IS NULL`,
            [workflowId],
          );
          await tx.client.query(
            `INSERT INTO ${table(tx, commonTables.workflowAutomationGrants)}
            (id,workflow_id,revision,membership_id,draft_version,command_id,source_id,source_generation,destination_id,
             destination_generation,destination_version,sender,messages_per_hour,private_repository_export,sharing_membership_id,approval,digest,policy_version,sponsorship_id)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$4,$15,$16,1,$17)`,
            [
              grantId,
              workflowId,
              draft.revision,
              actor.membershipId,
              draft.version,
              input.commandId,
              draft.setup.source.sourceId,
              draft.setup.source.generation,
              target.destinationId,
              target.generation,
              target.version,
              target.sender,
              draft.setup.messagesPerHour,
              input.privateRepositoryExport,
              approval,
              automationApprovalDigest(approval),
              sponsor.sponsorship_id,
            ],
          );
        }
        await tx.client.query(
          `INSERT INTO ${table(tx, commonTables.workflowAutomationDecisions)}
          (command_id,workflow_id,membership_id,version,digest,decision,private_repository_export,grant_id)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            input.commandId,
            workflowId,
            actor.membershipId,
            draft.version,
            input.digest,
            input.decision,
            input.privateRepositoryExport,
            grantId,
          ],
        );
        await auditWorkflow(tx, actor.userId, `workflow.automation.${input.decision}`, workflowId);
      });
      const receipt = await loadDecision(tx, draft);
      if (!receipt) throw new WorkflowConflict('automation-receipt-missing');
      return receipt;
    });
  }
  async function revoke(workspaceId: string, userId: string, grantIdInput: string, value: unknown) {
    const grantId = idSchema.parse(grantIdInput),
      input = automationRevokeSchema.parse(value);
    return transaction(workspaceId, userId, async (tx, actor) => {
      const grant = z
        .object({ workflow_id: idSchema, membership_id: idSchema, digest: z.string() })
        .optional()
        .parse(
          (
            await tx.client.query(
              `SELECT workflow_id,membership_id,digest FROM ${table(tx, commonTables.workflowAutomationGrants)} WHERE id=$1`,
              [grantId],
            )
          ).rows[0],
        );
      if (
        !grant ||
        (grant.membership_id !== actor.membershipId &&
          !(await hasGrant(tx, actor.membershipId, grant.workflow_id, 'manage')))
      )
        throw new AccessDenied();
      await administrativeCommand(
        tx,
        {
          commandId: input.commandId,
          expectedGeneration: 1,
          generation: 1,
          membershipId: actor.membershipId,
          operation: 'workflow.automation.revoke',
          target: grantId,
          request: input,
        },
        async () => {
          if (input.digest !== grant.digest) throw new WorkflowConflict('automation-digest-conflict');
          await tx.client.query(
            `UPDATE ${table(tx, commonTables.workflowAutomationGrants)} SET revoked_at=clock_timestamp()
          WHERE id=$1 AND revoked_at IS NULL`,
            [grantId],
          );
          await auditWorkflow(tx, actor.userId, 'workflow.automation.revoke', grant.workflow_id);
        },
      );
      return { grantId, revoked: true };
    });
  }
  return { saveDraft, readDraft, decide, revoke };
}
