import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AccessDenied, type AuthorizationTransaction } from '@tulipfarm/access';
import {
  workflowTransaction,
  workflowMember,
  hasGrant,
  requireGrant,
  requireSponsor,
  initializeManager,
  disableAutomatically,
} from './authorization.ts';
import { changeGrant, listGrants } from './sharing.ts';
import { credentialCipher, type IntegrationKeyring } from '@tulipfarm/integrations/credentials';
import { qualified } from '@tulipfarm/workspace-storage/runtime';
import { definitionSchema, idSchema, payloadSchema } from './contracts.ts';
import {
  providerIntegrationInputSchema,
  providerIntegrationSchema,
  providerCursorSchema,
  providerSourceSchema,
  providerStatusSchema,
  providerUpdateSchema,
  providerTriggerSchema,
  type ProviderTrigger,
} from './provider-contracts.ts';
import { administrativeCommand, administrativeReplay, WorkflowLimitReached, workflowLimits } from './commands.ts';
import { createProviderAdapters, ProviderFailure } from './provider-adapters.ts';
import { createProviderDiscovery } from './provider-discovery.ts';
import type { WorkflowRuntime } from './service.ts';

const table = (tx: AuthorizationTransaction, name: string) => qualified(tx.schema, name);
const integrationRow = z.object({
  id: idSchema,
  name: z.string(),
  source: providerSourceSchema,
  membership_id: idSchema,
  credential: z.unknown(),
  generation: z.number().int(),
  enabled: z.boolean(),
  authorized: z.boolean(),
});
const versionedCredential = z.object({ generation: z.number().int().positive(), envelope: z.unknown() });
function credentialVersion(row: z.infer<typeof integrationRow>) {
  const parsed = versionedCredential.safeParse(row.credential);
  return parsed.success ? parsed.data : { generation: row.generation, envelope: row.credential };
}
export type ProviderOptions = { keyring?: IntegrationKeyring; providerFetch?: typeof fetch };

export function createWorkflowProviders(runtime: WorkflowRuntime, options: ProviderOptions = {}) {
  const cipher = credentialCipher(options.keyring);
  const adapters = createProviderAdapters(options.providerFetch);
  const discovery = createProviderDiscovery(options.providerFetch);
  async function transaction<T>(
    workspaceId: string,
    operation: (tx: AuthorizationTransaction) => Promise<T>,
    mode: 'read' | 'write' = 'write',
  ) {
    return workflowTransaction(runtime, workspaceId, operation, mode);
  }
  async function integration(tx: AuthorizationTransaction, id: string) {
    const row = (
      await tx.client.query(
        `SELECT c.*, (m.removed_at IS NULL) AS authorized FROM ${table(tx, 'tf_provider_integrations')} c JOIN ${table(tx, 'tf_memberships')} m ON m.id=c.membership_id WHERE c.id=$1`,
        [idSchema.parse(id)],
      )
    ).rows[0];
    if (!row) throw new AccessDenied();
    return integrationRow.parse(row);
  }
  async function authorize(tx: AuthorizationTransaction, trigger: ProviderTrigger, membershipId: string) {
    return authorizeIntegration(tx, trigger.integrationId, membershipId, trigger.event === 'updated');
  }
  async function authorizeIntegration(
    tx: AuthorizationTransaction,
    integrationId: string,
    membershipId: string,
    updated = false,
  ) {
    await requireGrant(tx, membershipId, integrationId, 'use', 'provider');
    const row = await integration(tx, integrationId);
    if (!row.enabled || !row.authorized || (updated && row.source.provider !== 'sheets')) throw new AccessDenied();
    return row;
  }
  async function credential(
    workspaceId: string,
    tx: AuthorizationTransaction,
    integrationId: string,
    membershipId: string,
  ) {
    const row = await authorizeIntegration(tx, integrationId, membershipId);
    const saved = credentialVersion(row);
    return cipher.decrypt(workspaceId, row.id, saved.generation, saved.envelope);
  }
  async function check(workspaceId: string, user: string, value: unknown) {
    const trigger = providerTriggerSchema.parse(value);
    return transaction(workspaceId, async tx => {
      const actor = await workflowMember(tx, user);
      const row = await authorize(tx, trigger, actor.membershipId);
      return { id: row.id, name: row.name, source: row.source };
    });
  }
  async function audit(tx: AuthorizationTransaction, membershipId: string, id: string, operation: string) {
    await tx.client.query(
      `INSERT INTO ${table(tx, 'tf_audit_events')} (id,actor_id,operation,subject_id) VALUES ($1,$2,$3,$4)`,
      [randomUUID(), membershipId, `workflow.provider.${operation}`, id],
    );
  }
  async function activate(
    tx: AuthorizationTransaction,
    workflowId: string,
    revision: string,
    trigger: ProviderTrigger,
  ) {
    const sponsor = await requireSponsor(tx, workflowId, revision);
    await authorize(tx, trigger, sponsor.sponsor_membership_id);
    const cursor = providerCursorSchema.parse({ since: new Date().toISOString(), until: null, page: null });
    await tx.client.query(
      `INSERT INTO ${table(tx, 'tf_provider_polls')} (workflow_id,revision,integration_id,cursor,fence) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (workflow_id) DO UPDATE SET revision=$2,integration_id=$3,cursor=$4,fence=$5,next_poll=clock_timestamp(),last_success=NULL,error=NULL`,
      [workflowId, revision, trigger.integrationId, JSON.stringify(cursor), randomUUID()],
    );
    // Waiting events belong to the previous activation; a backlog they formed would disable this one on its first poll.
    await tx.client.query(`DELETE FROM ${table(tx, 'tf_provider_events')} WHERE workflow_id=$1 AND NOT admitted`, [
      workflowId,
    ]);
  }
  async function list(workspaceId: string, user: string) {
    return transaction(
      workspaceId,
      async tx => {
        const actor = await workflowMember(tx, user);
        const rows = (
          await tx.client.query(
            `SELECT c.id,c.name,c.source,c.enabled,c.generation,c.membership_id,(m.removed_at IS NULL) AS authorized FROM ${table(tx, 'tf_provider_integrations')} c JOIN ${table(tx, 'tf_memberships')} m ON m.id=c.membership_id ORDER BY c.name,c.id LIMIT 100`,
          )
        ).rows;
        const result = [];
        for (const row of rows) {
          const capabilities = {
            use: await hasGrant(tx, actor.membershipId, row.id, 'use', 'provider'),
            manage: await hasGrant(tx, actor.membershipId, row.id, 'manage', 'provider'),
            rotate: actor.membershipId === row.membership_id,
          };
          if (capabilities.use || capabilities.manage)
            result.push(providerIntegrationSchema.parse({ ...row, capabilities }));
        }
        return result;
      },
      'read',
    );
  }
  async function create(workspaceId: string, user: string, input: unknown) {
    const value = providerIntegrationInputSchema.parse(input);
    const digest = createHash('sha256').update(JSON.stringify(value)).digest('hex');
    async function capacity(tx: AuthorizationTransaction, membershipId: string) {
      const counts = z
        .object({ workspace: z.number(), member: z.number() })
        .parse(
          (
            await tx.client.query(
              `SELECT count(*)::integer AS workspace,count(*) FILTER (WHERE membership_id=$1)::integer AS member FROM ${table(tx, 'tf_provider_integrations')}`,
              [membershipId],
            )
          ).rows[0],
        );
      if (counts.member >= workflowLimits.member) throw new WorkflowLimitReached('member');
      if (counts.workspace >= workflowLimits.workspace) throw new WorkflowLimitReached('workspace');
    }
    const preflight = await transaction(workspaceId, async tx => {
      const actor = await workflowMember(tx, user);
      const existing = (
        await tx.client.query(
          `SELECT creation_digest,membership_id FROM ${table(tx, 'tf_provider_integrations')} WHERE id=$1`,
          [value.id],
        )
      ).rows[0];
      if (!existing) {
        await capacity(tx, actor.membershipId);
        return { replay: false, membershipId: actor.membershipId };
      }
      await requireGrant(tx, actor.membershipId, value.id, 'manage', 'provider');
      if (existing.creation_digest !== digest || existing.membership_id !== actor.membershipId)
        throw new ProviderFailure('source-invalid');
      return { replay: true, membershipId: actor.membershipId };
    });
    if (preflight.replay) return { saved: true };
    await discovery.test({ source: value.source, token: value.token });
    return transaction(workspaceId, async tx => {
      const actor = await workflowMember(tx, user);
      if (actor.membershipId !== preflight.membershipId) throw new AccessDenied();
      const existing = (
        await tx.client.query(
          `SELECT creation_digest,membership_id FROM ${table(tx, 'tf_provider_integrations')} WHERE id=$1`,
          [value.id],
        )
      ).rows[0];
      if (existing) {
        await requireGrant(tx, actor.membershipId, value.id, 'manage', 'provider');
        if (existing.creation_digest !== digest || existing.membership_id !== actor.membershipId)
          throw new ProviderFailure('source-invalid');
        return { saved: true };
      }
      await capacity(tx, actor.membershipId);
      const credential = { generation: 1, envelope: cipher.encrypt(workspaceId, value.id, 1, value.token) };
      await tx.client.query(
        `INSERT INTO ${table(tx, 'tf_provider_integrations')} (id,name,source,membership_id,credential,creation_digest) VALUES ($1,$2,$3,$4,$5,$6)`,
        [value.id, value.name, JSON.stringify(value.source), actor.membershipId, JSON.stringify(credential), digest],
      );
      await initializeManager(tx, value.id, actor.membershipId, 'provider');
      await audit(tx, actor.membershipId, value.id, 'consent');
      return { saved: true };
    });
  }
  async function update(workspaceId: string, user: string, id: string, input: unknown) {
    const value = providerUpdateSchema.parse(input);
    if (value.token) {
      const preflight = await transaction(workspaceId, async tx => {
        const actor = await workflowMember(tx, user);
        await requireGrant(tx, actor.membershipId, id, 'manage', 'provider');
        const row = await integration(tx, id);
        if (actor.membershipId !== row.membership_id || (value.enabled && !row.authorized)) throw new AccessDenied();
        const replay = await administrativeReplay(tx, {
          ...value,
          generation: row.generation,
          membershipId: actor.membershipId,
          operation: 'provider-update',
          target: row.id,
          request: value,
        });
        return { replay, source: row.source };
      });
      if (preflight.replay) return { saved: true };
      await discovery.test({ source: preflight.source, token: value.token });
    }
    return transaction(workspaceId, async tx => {
      const actor = await workflowMember(tx, user);
      await requireGrant(tx, actor.membershipId, id, 'manage', 'provider');
      const row = await integration(tx, id);
      if (value.token && actor.membershipId !== row.membership_id) throw new AccessDenied();
      if (value.enabled && !row.authorized) throw new AccessDenied();
      await administrativeCommand(
        tx,
        {
          ...value,
          generation: row.generation,
          membershipId: actor.membershipId,
          operation: 'provider-update',
          target: row.id,
          request: value,
        },
        async () => {
          const previous = credentialVersion(row);
          const credential =
            !value.enabled && !value.token
              ? previous
              : {
                  generation: row.generation + 1,
                  envelope: cipher.encrypt(
                    workspaceId,
                    id,
                    row.generation + 1,
                    value.token ?? cipher.decrypt(workspaceId, id, previous.generation, previous.envelope),
                  ),
                };
          await tx.client.query(
            `UPDATE ${table(tx, 'tf_provider_integrations')} SET enabled=$2,generation=generation+1,credential=$3 WHERE id=$1`,
            [id, value.enabled, JSON.stringify(credential)],
          );
          await tx.client.query(
            `UPDATE ${table(tx, 'tf_provider_polls')} SET fence=$2,next_poll=clock_timestamp() WHERE integration_id=$1`,
            [id, randomUUID()],
          );
          if (!value.enabled)
            await tx.client.query(
              `UPDATE ${table(tx, 'tf_workflow_runs')} r SET status='blocked',error='provider-disabled' FROM ${table(tx, 'tf_workflow_revisions')} d WHERE d.workflow_id=r.workflow_id AND d.id=r.revision AND d.definition->'trigger'->>'integrationId'=$1 AND r.status IN ('queued','running','waiting')`,
              [id],
            );
          await audit(tx, actor.membershipId, id, !value.enabled ? 'disable' : value.token ? 'rotate' : 'enable');
        },
      );
      return { saved: true };
    });
  }
  async function status(workspaceId: string, user: string, workflowId: string) {
    return transaction(workspaceId, async tx => {
      const actor = await workflowMember(tx, user);
      await requireGrant(tx, actor.membershipId, workflowId, 'manage');
      const row = (
        await tx.client.query(
          `SELECT p.last_success::text AS "lastSuccess",p.error,p.next_poll::text AS "nextPoll",(SELECT count(*)::integer FROM ${table(tx, 'tf_provider_events')} e WHERE e.workflow_id=p.workflow_id AND e.revision=p.revision AND NOT e.admitted) AS pending FROM ${table(tx, 'tf_provider_polls')} p WHERE workflow_id=$1`,
          [idSchema.parse(workflowId)],
        )
      ).rows[0];
      return providerStatusSchema.parse(row ?? { lastSuccess: null, error: null, pending: 0, nextPoll: null });
    });
  }
  async function poll(workspaceId: string) {
    const claim = await transaction(workspaceId, async tx => {
      const rows = (
        await tx.client.query(
          `SELECT p.workflow_id,p.revision,p.cursor,r.definition FROM ${table(tx, 'tf_provider_polls')} p JOIN ${table(tx, 'tf_workflows')} w ON w.id=p.workflow_id AND w.active_revision=p.revision JOIN ${table(tx, 'tf_workflow_revisions')} r ON r.workflow_id=w.id AND r.id=p.revision WHERE w.enabled AND p.next_poll<=clock_timestamp() ORDER BY p.next_poll,p.workflow_id LIMIT 1`,
        )
      ).rows;
      const row = rows[0];
      if (!row) return null;
      const workflowId = idSchema.parse(row.workflow_id),
        revision = idSchema.parse(row.revision),
        trigger = definitionSchema.parse(row.definition).trigger;
      if (trigger.kind !== 'provider') return null;
      try {
        const sponsor = await requireSponsor(tx, workflowId);
        const source = await authorize(tx, trigger, sponsor.sponsor_membership_id);
        const pending = z
          .number()
          .parse(
            (
              await tx.client.query(
                `SELECT count(*)::integer AS count FROM ${table(tx, 'tf_provider_events')} WHERE workflow_id=$1 AND revision=$2 AND NOT admitted`,
                [workflowId, revision],
              )
            ).rows[0]?.count,
          );
        if (pending >= 1000) throw new ProviderFailure('source-invalid');
        const fence = randomUUID();
        await tx.client.query(
          `UPDATE ${table(tx, 'tf_provider_polls')} SET fence=$2,next_poll=clock_timestamp()+interval '5 minutes' WHERE workflow_id=$1`,
          [workflowId, fence],
        );
        return {
          workflowId,
          revision,
          trigger,
          source,
          sponsor,
          fence,
          cursor: providerCursorSchema.parse(row.cursor),
        };
      } catch (error) {
        await disableAutomatically(
          tx,
          workflowId,
          error instanceof AccessDenied ? 'workflow.disable.sponsor-access-lost' : 'workflow.disable.provider-backlog',
        );
        await tx.client.query(
          `UPDATE ${table(tx, 'tf_provider_polls')} SET error='authority-or-capacity',next_poll=clock_timestamp()+interval '1 minute' WHERE workflow_id=$1`,
          [workflowId],
        );
        return null;
      }
    });
    if (!claim) return;
    try {
      const saved = credentialVersion(claim.source);
      const credential = cipher.decrypt(workspaceId, claim.source.id, saved.generation, saved.envelope);
      const page = await adapters.poll(claim.source.source, credential, claim.cursor);
      await transaction(workspaceId, async tx => {
        const sponsor = await requireSponsor(tx, claim.workflowId);
        if (sponsor.sponsorship_id !== claim.sponsor.sponsorship_id) return;
        const source = await authorize(tx, claim.trigger, sponsor.sponsor_membership_id);
        if (source.generation !== claim.source.generation) return;
        const live = (
          await tx.client.query(
            `SELECT 1 FROM ${table(tx, 'tf_provider_polls')} p JOIN ${table(tx, 'tf_workflows')} w ON w.id=p.workflow_id WHERE p.workflow_id=$1 AND p.fence=$2 AND p.revision=$3 AND w.enabled AND w.active_revision=$3`,
            [claim.workflowId, claim.fence, claim.revision],
          )
        ).rowCount;
        if (!live) return;
        const pending = z
          .number()
          .parse(
            (
              await tx.client.query(
                `SELECT count(*)::integer AS count FROM ${table(tx, 'tf_provider_events')} WHERE workflow_id=$1 AND revision=$2 AND NOT admitted`,
                [claim.workflowId, claim.revision],
              )
            ).rows[0]?.count,
          );
        if (pending + page.events.filter(item => item.kind === claim.trigger.event).length > 1000)
          throw new ProviderFailure('source-invalid');
        for (const item of page.events)
          if (item.kind === claim.trigger.event)
            await tx.client.query(
              `INSERT INTO ${table(tx, 'tf_provider_events')} (workflow_id,revision,event_key,payload) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
              [claim.workflowId, claim.revision, item.key, JSON.stringify(payloadSchema.parse(item.payload))],
            );
        await tx.client.query(
          `UPDATE ${table(tx, 'tf_provider_polls')} SET cursor=$2,last_success=clock_timestamp(),error=NULL,next_poll=clock_timestamp()+$3*interval '1 second' WHERE workflow_id=$1`,
          [claim.workflowId, JSON.stringify(page.cursor), page.cursor.page ? 60 : claim.trigger.minutes * 60],
        );
      });
    } catch (error) {
      const failure = error instanceof ProviderFailure ? error : new ProviderFailure('unavailable');
      await transaction(workspaceId, async tx => {
        await tx.client.query(
          `UPDATE ${table(tx, 'tf_provider_polls')} SET error=$3,next_poll=clock_timestamp()+$4*interval '1 second' WHERE workflow_id=$1 AND fence=$2`,
          [claim.workflowId, claim.fence, failure.code, failure.retrySeconds],
        );
      });
    }
  }
  const grants = (workspaceId: string, user: string, id: string) =>
    transaction(workspaceId, tx => listGrants(tx, user, id, 'provider'));
  const share = (workspaceId: string, user: string, id: string, value: unknown) =>
    transaction(workspaceId, tx => changeGrant(tx, user, id, value, 'provider'));
  async function test(workspaceId: string, user: string, input: unknown) {
    await transaction(workspaceId, tx => workflowMember(tx, user));
    const result = await discovery.test(input);
    await transaction(workspaceId, tx => workflowMember(tx, user));
    return result;
  }
  async function resources(workspaceId: string, user: string, input: unknown) {
    await transaction(workspaceId, tx => workflowMember(tx, user));
    const result = await discovery.resources(input);
    await transaction(workspaceId, tx => workflowMember(tx, user));
    return result;
  }
  return {
    list,
    check,
    create,
    update,
    test,
    resources,
    status,
    activate,
    authorize,
    authorizeIntegration,
    credential,
    poll,
    grants,
    share,
  };
}
