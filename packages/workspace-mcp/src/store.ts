import { z } from 'zod';
import {
  AccessDenied,
  currentMember,
  lockAuthorization,
  resolveHuman,
  type AuthorizationTransaction,
  type HumanActor,
} from '@tulipfarm/access';
import { qualified } from '@tulipfarm/workspace-storage/runtime';
import { withMaintenanceTransaction } from '@tulipfarm/workspace-storage/provisioning';
import { canManageIntegration } from '@tulipfarm/integrations/authorization';
import {
  McpError,
  integrationRowSchema,
  actionRowSchema,
  mcpCredentialSchema,
  mcpOriginSchema,
  mcpSourcesSchema,
  workspaceMcpCompatibility,
  type WorkspaceMcpOptions,
  type McpPrincipal,
  type IntegrationRow,
  type McpOrigin,
  type McpPhase,
  type McpSourceDependency,
} from './contracts.ts';
import { mcpCredentialCipher } from './credentials.ts';
import { canonicalJson, digest } from './validation.ts';

export const table = (tx: AuthorizationTransaction, name: string) => qualified(tx.schema, `tf_mcp_${name}`);
export const originKey = (origin: McpOrigin) =>
  origin.kind === 'private-chat' ? `chat:${origin.conversationId}` : `task:${origin.taskId}`;
export const bindingsSchema = z
  .array(
    z.strictObject({
      integrationId: z.uuid(),
      authorizationEpoch: z.number().int().positive(),
      slotId: z.string().nullable().optional(),
    }),
  )
  .max(20);
export const selectionSchema = z.object({ version: z.number().int(), bindings: bindingsSchema });
export function sourceUnion(...groups: McpSourceDependency[][]) {
  return [...new Map(groups.flat().map(source => [canonicalJson(source), source])).entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, source]) => source);
}
export function createStore(options: WorkspaceMcpOptions) {
  const cipher = mcpCredentialCipher(options.keyring);
  async function transaction<T>(workspaceId: string, operation: (tx: AuthorizationTransaction) => Promise<T>) {
    return options.runtime.transaction(z.uuid().parse(workspaceId), workspaceMcpCompatibility, async tx => {
      await lockAuthorization(tx, 'write');
      return operation(tx);
    });
  }
  async function authorized<T>(
    workspaceId: string,
    principal: McpPrincipal,
    operation: (tx: AuthorizationTransaction, actor: HumanActor) => Promise<T>,
  ) {
    return transaction(workspaceId, async tx => {
      const actor = typeof principal === 'string' ? await resolveHuman(tx, principal) : principal;
      await currentMember(tx, actor);
      return operation(tx, actor);
    });
  }
  async function confirmation<T>(
    workspaceId: string,
    principal: McpPrincipal,
    operation: (tx: AuthorizationTransaction, actor: HumanActor) => Promise<T>,
  ) {
    if (!options.resolveConfirmationCredential) throw new McpError('disabled');
    const actor = await authorized(workspaceId, principal, async (_tx, actor) => actor);
    return withMaintenanceTransaction({
      workspaceId,
      connectionString: await options.resolveConfirmationCredential(workspaceId),
      capability: 'confirmation',
      operation: async tx => {
        await lockAuthorization(tx, 'write');
        await currentMember(tx, actor);
        return operation(tx, actor);
      },
    });
  }
  async function load(tx: AuthorizationTransaction, id: string) {
    const row = integrationRowSchema
      .optional()
      .parse(
        (
          await tx.client.query(`SELECT * FROM ${table(tx, 'integrations')} WHERE id=$1 FOR UPDATE`, [
            z.uuid().parse(id),
          ])
        ).rows[0],
      );
    if (!row) throw new AccessDenied();
    return row;
  }
  async function capabilities(tx: AuthorizationTransaction, actor: HumanActor, row: IntegrationRow) {
    await currentMember(tx, actor);
    if (row.ownership === 'personal') {
      const owner = row.owner_membership_id === actor.membershipId;
      return { read: owner, manage: owner, use: owner };
    }
    const manage = await canManageIntegration(tx, actor, 'mcp', row.id);
    const use = Boolean(
      (
        await tx.client.query(
          `SELECT 1 FROM ${table(tx, 'member_grants')} WHERE integration_id=$1 AND membership_id=$2
      UNION ALL SELECT 1 FROM ${table(tx, 'team_grants')} g JOIN ${qualified(tx.schema, 'tf_member_teams')} mt ON mt.team_id=g.team_id WHERE g.integration_id=$1 AND mt.membership_id=$2 LIMIT 1`,
          [row.id, actor.membershipId],
        )
      ).rowCount,
    );
    return { read: manage || use, manage, use };
  }
  async function permit(
    tx: AuthorizationTransaction,
    actor: HumanActor,
    row: IntegrationRow,
    permission: 'read' | 'manage' | 'use',
  ) {
    if (!(await capabilities(tx, actor, row))[permission]) throw new AccessDenied();
  }
  function active(row: IntegrationRow) {
    if (row.lifecycle !== 'active' || row.refresh_claim) throw new McpError('integration-unavailable');
  }
  function credential(workspaceId: string, row: IntegrationRow) {
    try {
      return mcpCredentialSchema.parse(
        JSON.parse(
          cipher.decrypt(
            { workspaceId, integrationId: row.id, version: row.secret_version, purpose: 'credential' },
            row.credential,
          ),
        ),
      );
    } catch {
      throw new McpError('credential-unavailable');
    }
  }
  async function barrier(tx: AuthorizationTransaction, integrationId: string) {
    return Boolean(
      (
        await tx.client.query(
          `SELECT 1 FROM ${table(tx, 'claims')} c LEFT JOIN ${table(tx, 'receipts')} r ON r.action_id=c.action_id WHERE c.integration_id=$1
      AND (r.action_id IS NULL OR (r.status='outcome-unknown' AND NOT EXISTS (SELECT 1 FROM ${table(tx, 'reconciliations')} h WHERE h.action_id=c.action_id AND h.observation<>'still-unknown'))) LIMIT 1`,
          [integrationId],
        )
      ).rowCount,
    );
  }
  async function metadata(tx: AuthorizationTransaction, actor: HumanActor, row: IntegrationRow) {
    await permit(tx, actor, row, 'read');
    const barrierRow = z
      .object({ action_id: z.uuid() })
      .optional()
      .parse(
        (
          await tx.client.query(
            `SELECT c.action_id FROM ${table(tx, 'claims')} c JOIN ${table(tx, 'actions')} a ON a.id=c.action_id LEFT JOIN ${table(tx, 'receipts')} r ON r.action_id=c.action_id WHERE c.integration_id=$1 AND a.requester->>'membershipId'=$2 AND a.requester->>'userId'=$3 AND (r.action_id IS NULL OR (r.status='outcome-unknown' AND NOT EXISTS (SELECT 1 FROM ${table(tx, 'reconciliations')} h WHERE h.action_id=c.action_id AND h.observation<>'still-unknown'))) ORDER BY c.created_at LIMIT 1`,
            [row.id, actor.membershipId, actor.userId],
          )
        ).rows[0],
      );
    return {
      id: row.id,
      ownership: row.ownership,
      name: row.name,
      endpoint: row.endpoint,
      serverIdentity: row.server_identity,
      descriptorApproved: row.descriptor_approved,
      lifecycle: row.lifecycle,
      authorizationEpoch: row.authorization_epoch,
      secretVersion: row.secret_version,
      grantsVersion: row.grants_version,
      version: row.version,
      authMethod: row.auth_method,
      refreshDue:
        row.auth_method === 'oauth' &&
        !!row.credential_expires_at &&
        row.credential_expires_at.getTime() <= Date.now() + 60_000,
      blocked: await barrier(tx, row.id),
      barrierActionId: barrierRow?.action_id ?? null,
      capabilities: await capabilities(tx, actor, row),
    };
  }
  async function invalidate(tx: AuthorizationTransaction, row: IntegrationRow) {
    await tx.client.query(
      `UPDATE ${table(tx, 'integrations')} SET authorization_epoch=authorization_epoch+1,descriptor_approved=false,refresh_claim=NULL,refresh_started_at=NULL WHERE id=$1`,
      [row.id],
    );
    await tx.client.query(
      `UPDATE ${table(tx, 'tool_policies')} SET enabled_revision=NULL,standing_exception=false,policy_version=policy_version+1 WHERE integration_id=$1`,
      [row.id],
    );
    await tx.client.query(
      `UPDATE ${table(tx, 'oauth_attempts')} SET state='consumed',material=NULL WHERE integration_id=$1`,
      [row.id],
    );
  }
  async function sources(tx: AuthorizationTransaction, actor: HumanActor, input: McpSourceDependency[]) {
    const values = mcpSourcesSchema.parse(input);
    for (const source of values)
      if (source.kind === 'mcp-integration') {
        const row = await load(tx, source.integrationId);
        await permit(tx, actor, row, 'use');
        if (row.lifecycle !== 'active') throw new AccessDenied();
        if (row.authorization_epoch !== source.authorizationEpoch) throw new AccessDenied();
      }
    await options.authorizeSources({ transaction: tx, actor, sources: values });
  }
  async function origin(tx: AuthorizationTransaction, actor: HumanActor, input: McpOrigin, phase: McpPhase) {
    const value = mcpOriginSchema.parse(input);
    const authority = await options.authorizeOrigin({ transaction: tx, actor, origin: value, phase });
    const closure = sourceUnion(
      mcpSourcesSchema.parse(authority.sources),
      value.kind === 'private-chat' ? [{ kind: 'private-conversation', conversationId: value.conversationId }] : [],
    );
    if (value.kind === 'named-task' && (!Array.isArray(authority.allowedTools) || !closure.length))
      throw new AccessDenied();
    await sources(tx, actor, closure);
    return { ...authority, sources: closure };
  }
  async function selection(tx: AuthorizationTransaction, actor: HumanActor, origin: McpOrigin) {
    if (origin.kind === 'private-chat') return chatSelection(tx, actor);
    return (
      selectionSchema
        .optional()
        .parse(
          (
            await tx.client.query(
              `SELECT version,bindings FROM ${table(tx, 'selections')} WHERE membership_id=$1 AND origin_key=$2`,
              [actor.membershipId, originKey(origin)],
            )
          ).rows[0],
        ) ?? { version: 0, bindings: [] }
    );
  }
  // Private chats expose every usable integration; version stays 0 so approvals survive unrelated integration changes, while per-binding epochs still guard each call.
  async function chatSelection(tx: AuthorizationTransaction, actor: HumanActor) {
    // ponytail: first 20 integrations by creation (bindingsSchema cap); add per-chat narrowing when users need more.
    const rows = z
      .array(integrationRowSchema)
      .parse(
        (
          await tx.client.query(
            `SELECT * FROM ${table(tx, 'integrations')} WHERE lifecycle='active' AND refresh_claim IS NULL ORDER BY created_at,id`,
          )
        ).rows,
      );
    const bindings = [];
    for (const row of rows) {
      if (bindings.length === 20) break;
      if ((await capabilities(tx, actor, row)).use)
        bindings.push({ integrationId: row.id, authorizationEpoch: row.authorization_epoch });
    }
    return { version: 0, bindings };
  }
  async function action(tx: AuthorizationTransaction, id: string) {
    const row = actionRowSchema
      .optional()
      .parse(
        (await tx.client.query(`SELECT * FROM ${table(tx, 'actions')} WHERE id=$1`, [z.uuid().parse(id)])).rows[0],
      );
    if (!row) throw new AccessDenied();
    return row;
  }
  async function command<T>(
    tx: AuthorizationTransaction,
    actor: HumanActor,
    requestId: string | undefined,
    kind: string,
    input: unknown,
    schema: z.ZodType<T>,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (!requestId) return operation();
    z.uuid().parse(requestId);
    const hash = digest([kind, input]);
    const old = z
      .object({ kind: z.string(), digest: z.string(), result: z.unknown() })
      .optional()
      .parse(
        (
          await tx.client.query(
            `SELECT kind,digest,result FROM ${table(tx, 'commands')} WHERE membership_id=$1 AND request_id=$2`,
            [actor.membershipId, requestId],
          )
        ).rows[0],
      );
    if (old) {
      if (old.kind !== kind || old.digest !== hash) throw new McpError('conflict');
      return schema.parse(old.result);
    }
    const result = await operation();
    await tx.client.query(
      `INSERT INTO ${table(tx, 'commands')} (membership_id,request_id,kind,digest,result) VALUES ($1,$2,$3,$4,$5)`,
      [actor.membershipId, requestId, kind, hash, JSON.stringify(result)],
    );
    return result;
  }
  return {
    transaction,
    authorized,
    confirmation,
    load,
    capabilities,
    permit,
    active,
    credential,
    cipher,
    barrier,
    metadata,
    invalidate,
    sources,
    origin,
    selection,
    action,
    command,
  };
}
export type McpStore = ReturnType<typeof createStore>;
