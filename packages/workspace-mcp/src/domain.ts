import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AccessDenied, type AuthorizationTransaction, type HumanActor } from '@tulipfarm/access';
import {
  integrationManagers,
  managerGrantsSchema,
  setIntegrationManagers,
  validateIntegrationRecipients,
  changedIntegrationRecommendationMembers,
  recordIntegrationRecommendationChange,
  watchIntegrationRecommendations,
} from '@tulipfarm/integrations/authorization';
import {
  McpError,
  mcpLimits,
  mcpCredentialSchema,
  mcpOriginSchema,
  mcpToolSchema,
  mcpResultSchema,
  jsonObjectSchema,
  integrationMetadataSchema,
  type WorkspaceMcpOptions,
  type McpPrincipal,
  type McpOrigin,
  type McpTool,
  type ActionRow,
  type IntegrationRow,
  type McpPhase,
} from './contracts.ts';
import { createStore, table, originKey, bindingsSchema, sourceUnion } from './store.ts';
import {
  canonicalJson,
  bounded,
  digest,
  endpointIdentity,
  serverIdentity,
  toolRevision,
  toolCompatibility,
  validateArguments,
  validateOutput,
  rejectReflectedSecrets,
} from './validation.ts';
import { oauthMethods } from './oauth.ts';
import { selectionMethods } from './selections.ts';
import { mcpRecommendations } from './recommendations.ts';

const policySchema = z.object({
  name: z.string(),
  discovered_revision: z.string(),
  enabled_revision: z.string().nullable(),
  standing_exception: z.boolean(),
  policy_version: z.number().int(),
  present: z.boolean(),
  tool: mcpToolSchema,
  compatibility_reason: z.string().nullable(),
});
const decisionSchema = z.object({ decision: z.enum(['approve', 'reject']), digest: z.string() });
const receiptSchema = z.object({
  status: z.enum(['succeeded', 'outcome-unknown']),
  result: mcpResultSchema.nullable(),
});

export function createWorkspaceMcp(options: WorkspaceMcpOptions) {
  if (typeof options.authorizeOrigin !== 'function' || typeof options.authorizeSources !== 'function')
    throw new McpError('disabled');
  const store = createStore(options);
  const admitted = () => {
    if (!options.admissionEnabled) throw new McpError('disabled');
  };
  const dispatchEnabled = () => {
    if (!options.dispatchEnabled) throw new McpError('disabled');
  };
  async function policies(tx: AuthorizationTransaction, id: string) {
    return z
      .array(policySchema)
      .parse(
        (
          await tx.client.query(
            `SELECT p.*,r.tool,r.compatibility_reason FROM ${table(tx, 'tool_policies')} p JOIN ${table(tx, 'tool_revisions')} r ON r.integration_id=p.integration_id AND r.name=p.name AND r.revision=p.discovered_revision WHERE p.integration_id=$1 ORDER BY p.name`,
            [id],
          )
        ).rows,
      );
  }
  function allowed(
    authority: Awaited<ReturnType<typeof store.origin>>,
    row: IntegrationRow,
    name: string,
    revision: string,
    bindings: z.infer<typeof bindingsSchema>,
  ) {
    if (authority.allowedTools !== null && row.ownership === 'personal' && !row.descriptor_approved) return false;
    return (
      authority.allowedTools === null ||
      authority.allowedTools.some(
        tool =>
          tool.serverIdentity === row.server_identity &&
          tool.name === name &&
          tool.revision === revision &&
          (!tool.integrationId || tool.integrationId === row.id) &&
          !!tool.slotId &&
          bindings.some(
            binding =>
              binding.integrationId === row.id &&
              binding.authorizationEpoch === row.authorization_epoch &&
              binding.slotId === tool.slotId,
          ),
      )
    );
  }
  async function readyTool(tx: AuthorizationTransaction, row: IntegrationRow, name: string, revision: string) {
    const policy = (await policies(tx, row.id)).find(policy => policy.name === name);
    if (
      !policy ||
      !policy.present ||
      policy.compatibility_reason ||
      policy.enabled_revision !== revision ||
      policy.discovered_revision !== revision
    )
      throw new McpError('incompatible-tool');
    return policy;
  }
  async function authorizeAction(
    tx: AuthorizationTransaction,
    actor: HumanActor,
    action: ActionRow,
    phase: McpPhase,
    fresh = true,
  ) {
    if (actor.membershipId !== action.requester.membershipId || actor.userId !== action.requester.userId)
      throw new AccessDenied();
    const row = await store.load(tx, action.integration_id);
    await store.permit(tx, actor, row, 'use');
    if (fresh) store.active(row);
    else if (row.lifecycle !== 'active') throw new McpError('integration-unavailable');
    if (row.authorization_epoch !== action.authorization_epoch) throw new AccessDenied();
    const authority = await store.origin(tx, actor, action.origin, phase);
    await store.sources(tx, actor, action.sources);
    if (fresh) {
      const now = z
        .object({ expired: z.boolean() })
        .parse(
          (await tx.client.query('SELECT $1::timestamptz <= clock_timestamp() AS expired', [action.expires_at]))
            .rows[0],
        );
      if (now.expired) throw new McpError('expired');
      const selection = await store.selection(tx, actor, action.origin);
      if (
        selection.version !== action.selection_version ||
        !selection.bindings.some(
          binding => binding.integrationId === row.id && binding.authorizationEpoch === row.authorization_epoch,
        )
      )
        throw new McpError('conflict');
      const policy = await readyTool(tx, row, action.tool_name, action.tool_revision);
      if (
        policy.policy_version !== action.policy_version ||
        !allowed(authority, row, action.tool_name, action.tool_revision, selection.bindings)
      )
        throw new AccessDenied();
      if (
        canonicalJson(
          sourceUnion(authority.sources, [
            { kind: 'mcp-integration', integrationId: row.id, authorizationEpoch: row.authorization_epoch },
          ]),
        ) !== canonicalJson(action.sources)
      )
        throw new McpError('conflict');
      return { row, policy };
    }
    return { row, policy: null };
  }
  async function lifecycleStatus(tx: AuthorizationTransaction, action: ActionRow) {
    const receipt = receiptSchema
      .optional()
      .parse(
        (await tx.client.query(`SELECT status,result FROM ${table(tx, 'receipts')} WHERE action_id=$1`, [action.id]))
          .rows[0],
      );
    const decision = decisionSchema
      .optional()
      .parse(
        (await tx.client.query(`SELECT decision,digest FROM ${table(tx, 'decisions')} WHERE action_id=$1`, [action.id]))
          .rows[0],
      );
    const claimed = Boolean(
      (await tx.client.query(`SELECT 1 FROM ${table(tx, 'claims')} WHERE action_id=$1`, [action.id])).rowCount,
    );
    const cancelled = Boolean(
      (await tx.client.query(`SELECT 1 FROM ${table(tx, 'cancellations')} WHERE action_id=$1`, [action.id])).rowCount,
    );
    const standing = Boolean(
      (await tx.client.query(`SELECT 1 FROM ${table(tx, 'policy_evaluations')} WHERE action_id=$1`, [action.id]))
        .rowCount,
    );
    const { expired } = z
      .object({ expired: z.boolean() })
      .parse(
        (await tx.client.query('SELECT $1::timestamptz <= clock_timestamp() AS expired', [action.expires_at])).rows[0],
      );
    const status =
      receipt?.status ??
      (claimed
        ? 'dispatched'
        : cancelled
          ? 'cancelled-before-dispatch'
          : decision?.decision === 'reject'
            ? 'rejected-before-dispatch'
            : expired
              ? 'expired'
              : decision?.decision === 'approve' || standing
                ? 'ready'
                : 'awaiting-approval');
    return { receipt, status };
  }
  async function actionView(tx: AuthorizationTransaction, actor: HumanActor, action: ActionRow) {
    await authorizeAction(tx, actor, action, 'read', false);
    const { receipt, status } = await lifecycleStatus(tx, action);
    const observations = z
      .array(
        z.object({
          id: z.uuid(),
          observation: z.enum(['completed', 'not-performed', 'still-unknown']),
          administrative: z.boolean(),
          notes: z.string(),
          created_at: z.date(),
        }),
      )
      .parse(
        (
          await tx.client.query(
            `SELECT id,observation,administrative,notes,created_at FROM ${table(tx, 'reconciliations')} WHERE action_id=$1 ORDER BY created_at,id`,
            [action.id],
          )
        ).rows,
      );
    return {
      id: action.id,
      origin: action.origin,
      integrationId: action.integration_id,
      toolName: action.tool_name,
      toolRevision: action.tool_revision,
      arguments: action.arguments,
      sources: action.sources,
      digest: action.digest,
      requiresConsent: action.requires_consent,
      expiresAt: action.expires_at.toISOString(),
      status,
      receipt: receipt ?? null,
      reconciliations: observations,
    };
  }
  async function recoveryView(tx: AuthorizationTransaction, actor: HumanActor, action: ActionRow) {
    if (action.requester.membershipId !== actor.membershipId || action.requester.userId !== actor.userId)
      throw new AccessDenied();
    const integration = await store.load(tx, action.integration_id);
    const { status } = await lifecycleStatus(tx, action);
    const observation = z
      .object({
        observation: z.enum(['completed', 'not-performed', 'still-unknown']),
        created_at: z.date(),
        membership_id: z.uuid(),
        administrative: z.boolean(),
      })
      .optional()
      .parse(
        (
          await tx.client.query(
            `SELECT observation,created_at,membership_id,administrative FROM ${table(tx, 'reconciliations')} WHERE action_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1`,
            [action.id],
          )
        ).rows[0],
      );
    return {
      kind: 'requester-metadata' as const,
      id: action.id,
      integrationId: integration.id,
      integrationName: (await store.capabilities(tx, actor, integration)).read ? integration.name : 'MCP integration',
      digest: action.digest,
      expiresAt: action.expires_at.toISOString(),
      status,
      integrationPaused: await store.barrier(tx, integration.id),
      canReconcile: status === 'outcome-unknown' && (!observation || observation.observation === 'still-unknown'),
      reconciliation: observation
        ? {
            outcome: observation.observation,
            notes: '',
            observedAt: observation.created_at.toISOString(),
            observer: observation.membership_id,
            administrative: observation.administrative,
          }
        : null,
    };
  }
  async function discoverPrepared(workspaceId: string, row: IntegrationRow) {
    const credential = store.credential(workspaceId, row);
    let tools: McpTool[];
    try {
      const response = await timed(Date.now() + mcpLimits.discoveryMs, signal =>
        options.protocol.discover({ endpoint: row.endpoint, credential, signal }),
      );
      bounded(response, mcpLimits.catalogBytes);
      rejectReflectedSecrets(response, credential);
      tools = z.array(mcpToolSchema).max(mcpLimits.discoveredTools).parse(response.tools);
      if (new Set(tools.map(tool => tool.name)).size !== tools.length) throw new Error();
    } catch {
      throw new McpError('discovery-failed');
    }
    return tools;
  }
  async function saveDiscovery(tx: AuthorizationTransaction, row: IntegrationRow, tools: McpTool[]) {
    const recommendations = await watchIntegrationRecommendations(tx, row.id, () => mcpRecommendations(tx, row.id));
    const names = tools.map(tool => tool.name);
    await tx.client.query(
      `UPDATE ${table(tx, 'tool_policies')} SET present=false,enabled_revision=NULL,standing_exception=false,policy_version=policy_version+1 WHERE integration_id=$1 AND present AND NOT (name=ANY($2::text[]))`,
      [row.id, names],
    );
    for (const tool of tools) {
      const revision = toolRevision(tool);
      await tx.client.query(
        `INSERT INTO ${table(tx, 'tool_revisions')} (integration_id,name,revision,tool,compatibility_reason) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
        [row.id, tool.name, revision, tool, toolCompatibility(tool)],
      );
      await tx.client.query(
        `INSERT INTO ${table(tx, 'tool_policies')} (integration_id,name,discovered_revision) VALUES ($1,$2,$3) ON CONFLICT (integration_id,name) DO UPDATE SET
        discovered_revision=EXCLUDED.discovered_revision,present=true,
        enabled_revision=CASE WHEN tf_mcp_tool_policies.discovered_revision=EXCLUDED.discovered_revision AND tf_mcp_tool_policies.present THEN tf_mcp_tool_policies.enabled_revision ELSE NULL END,
        standing_exception=CASE WHEN tf_mcp_tool_policies.discovered_revision=EXCLUDED.discovered_revision AND tf_mcp_tool_policies.present THEN tf_mcp_tool_policies.standing_exception ELSE false END,
        policy_version=tf_mcp_tool_policies.policy_version+CASE WHEN tf_mcp_tool_policies.discovered_revision=EXCLUDED.discovered_revision AND tf_mcp_tool_policies.present THEN 0 ELSE 1 END`,
        [row.id, tool.name, revision],
      );
    }
    await recommendations();
  }
  const service = {
    async create(workspaceId: string, principal: McpPrincipal, input: unknown) {
      admitted();
      const value = z
        .strictObject({
          requestId: z.uuid().optional(),
          name: z.string().min(1).max(200),
          ownership: z.enum(['personal', 'shared']),
          endpoint: z.string(),
          credential: mcpCredentialSchema,
        })
        .parse(input);
      const endpoint = endpointIdentity(value.endpoint);
      return store.authorized(workspaceId, principal, async (tx, actor) => {
        const result = await store.command(
          tx,
          actor,
          value.requestId,
          'create',
          value,
          integrationMetadataSchema,
          async () => {
            const count = z
              .object({ count: z.number() })
              .parse(
                (
                  await tx.client.query(
                    `SELECT count(*)::integer AS count FROM ${table(tx, 'integrations')} WHERE lifecycle<>'deleted'`,
                  )
                ).rows[0],
              );
            if (count.count >= mcpLimits.integrations) throw new McpError('limit');
            const id = randomUUID();
            const recommendations = await watchIntegrationRecommendations(tx, id, () => mcpRecommendations(tx, id));
            const encrypted = store.cipher.encrypt(
              { workspaceId, integrationId: id, version: 1, purpose: 'credential' },
              JSON.stringify(value.credential),
            );
            rejectReflectedSecrets({ endpoint, name: value.name }, value.credential);
            await tx.client.query(
              `INSERT INTO ${table(tx, 'integrations')} (id,ownership,owner_membership_id,name,endpoint,server_identity,lifecycle,credential,auth_method,credential_expires_at) VALUES ($1,$2,$3,$4,$5,$6,'active',$7,$8,$9)`,
              [
                id,
                value.ownership,
                value.ownership === 'personal' ? actor.membershipId : null,
                value.name,
                endpoint,
                serverIdentity(endpoint),
                encrypted,
                value.credential.kind,
                value.credential.kind === 'oauth' ? value.credential.expiresAt : null,
              ],
            );
            if (value.ownership === 'shared') {
              await setIntegrationManagers(tx, actor, 'mcp', id, { memberIds: [actor.membershipId], teamIds: [] });
              await tx.client.query(
                `INSERT INTO ${table(tx, 'member_grants')} (integration_id,membership_id) VALUES ($1,$2)`,
                [id, actor.membershipId],
              );
            }
            await recommendations();
            return store.metadata(tx, actor, await store.load(tx, id));
          },
        );
        await store.permit(tx, actor, await store.load(tx, result.id), 'read');
        return result;
      });
    },
    async list(workspaceId: string, principal: McpPrincipal) {
      return store.authorized(workspaceId, principal, async (tx, actor) => {
        const ids = z
          .array(z.object({ id: z.uuid() }))
          .parse(
            (
              await tx.client.query(
                `SELECT id FROM ${table(tx, 'integrations')} WHERE lifecycle<>'deleted' AND (ownership='shared' OR owner_membership_id=$1) ORDER BY created_at,id`,
                [actor.membershipId],
              )
            ).rows,
          );
        const result = [];
        for (const { id } of ids) {
          const row = await store.load(tx, id);
          if ((await store.capabilities(tx, actor, row)).read) result.push(await store.metadata(tx, actor, row));
        }
        return result;
      });
    },
    status(workspaceId: string, principal: McpPrincipal, id: string) {
      return store.authorized(workspaceId, principal, async (tx, actor) =>
        store.metadata(tx, actor, await store.load(tx, id)),
      );
    },
    approveServerDescriptor(workspaceId: string, principal: McpPrincipal, id: string, expectedServerIdentity: string) {
      return store.authorized(workspaceId, principal, async (tx, actor) => {
        const row = await store.load(tx, id);
        await store.permit(tx, actor, row, 'manage');
        store.active(row);
        if (row.server_identity !== expectedServerIdentity) throw new McpError('conflict');
        const recommendations = await watchIntegrationRecommendations(tx, id, () => mcpRecommendations(tx, id));
        await tx.client.query(`UPDATE ${table(tx, 'integrations')} SET descriptor_approved=true WHERE id=$1`, [id]);
        await recommendations();
        return {
          serverIdentity: row.server_identity,
          tools: (await policies(tx, id))
            .filter(policy => policy.enabled_revision && !policy.compatibility_reason)
            .map(policy => ({ name: policy.name, revision: policy.enabled_revision })),
        };
      });
    },
    async setGrants(workspaceId: string, principal: McpPrincipal, id: string, input: unknown) {
      const value = z
        .strictObject({
          requestId: z.uuid().optional(),
          expectedVersion: z.number().int().positive(),
          memberIds: z.array(z.uuid()).max(1000),
          teamIds: z.array(z.uuid()).max(1000),
          managers: managerGrantsSchema.optional(),
        })
        .parse(input);
      return store.authorized(workspaceId, principal, async (tx, actor) => {
        const row = await store.load(tx, id);
        await store.permit(tx, actor, row, 'manage');
        if (row.ownership !== 'shared') throw new AccessDenied();
        const before = await store.metadata(tx, actor, row);
        return store.command(
          tx,
          actor,
          value.requestId,
          'grants',
          { id, ...value },
          integrationMetadataSchema,
          async () => {
            if ((value.requestId ? row.version : row.grants_version) !== value.expectedVersion)
              throw new McpError('conflict');
            const recommendationBefore = await mcpRecommendations(tx, id);
            await validateIntegrationRecipients(
              tx,
              actor,
              value,
              z
                .array(z.object({ team_id: z.uuid() }))
                .parse(
                  (
                    await tx.client.query(`SELECT team_id FROM ${table(tx, 'team_grants')} WHERE integration_id=$1`, [
                      id,
                    ])
                  ).rows,
                )
                .map(row => row.team_id),
            );
            if (value.managers) await setIntegrationManagers(tx, actor, 'mcp', id, value.managers);
            await tx.client.query(`DELETE FROM ${table(tx, 'member_grants')} WHERE integration_id=$1`, [id]);
            await tx.client.query(`DELETE FROM ${table(tx, 'team_grants')} WHERE integration_id=$1`, [id]);
            for (const member of new Set(value.memberIds))
              await tx.client.query(`INSERT INTO ${table(tx, 'member_grants')} VALUES ($1,$2)`, [id, member]);
            for (const team of new Set(value.teamIds))
              await tx.client.query(`INSERT INTO ${table(tx, 'team_grants')} VALUES ($1,$2)`, [id, team]);
            await tx.client.query(
              `UPDATE ${table(tx, 'integrations')} SET grants_version=grants_version+1,version=version+1 WHERE id=$1`,
              [id],
            );
            if (changedIntegrationRecommendationMembers(recommendationBefore, await mcpRecommendations(tx, id)).length)
              await store.invalidate(tx, row);
            await recordIntegrationRecommendationChange(tx, id, recommendationBefore, await mcpRecommendations(tx, id));
            const updated = await store.load(tx, id);
            const capabilities = await store.capabilities(tx, actor, updated);
            return capabilities.read
              ? store.metadata(tx, actor, updated)
              : {
                  ...before,
                  capabilities,
                  version: updated.version,
                  grantsVersion: updated.grants_version,
                  authorizationEpoch: updated.authorization_epoch,
                };
          },
        );
      });
    },
    grants(workspaceId: string, principal: McpPrincipal, id: string) {
      return store.authorized(workspaceId, principal, async (tx, actor) => {
        const row = await store.load(tx, id);
        await store.permit(tx, actor, row, 'manage');
        if (row.ownership !== 'shared') throw new AccessDenied();
        return {
          version: row.grants_version,
          managers: await integrationManagers(tx, 'mcp', id),
          memberIds: z
            .array(z.object({ membership_id: z.uuid() }))
            .parse(
              (
                await tx.client.query(
                  `SELECT membership_id FROM ${table(tx, 'member_grants')} WHERE integration_id=$1`,
                  [id],
                )
              ).rows,
            )
            .map(row => row.membership_id),
          teamIds: z
            .array(z.object({ team_id: z.uuid() }))
            .parse(
              (await tx.client.query(`SELECT team_id FROM ${table(tx, 'team_grants')} WHERE integration_id=$1`, [id]))
                .rows,
            )
            .map(row => row.team_id),
        };
      });
    },
    setLifecycle(
      workspaceId: string,
      principal: McpPrincipal,
      id: string,
      input:
        | 'active'
        | 'disabled'
        | 'disconnected'
        | 'deleted'
        | { requestId: string; expectedVersion: number; operation: 'enable' | 'disable' | 'disconnect' | 'delete' },
    ) {
      const value =
        typeof input === 'string'
          ? null
          : z
              .strictObject({
                requestId: z.uuid(),
                expectedVersion: z.number().int().positive(),
                operation: z.enum(['enable', 'disable', 'disconnect', 'delete']),
              })
              .parse(input);
      const lifecycle = value
        ? ({ enable: 'active', disable: 'disabled', disconnect: 'disconnected', delete: 'deleted' } as const)[
            value.operation
          ]
        : z.enum(['active', 'disabled', 'disconnected', 'deleted']).parse(input);
      return store.authorized(workspaceId, principal, async (tx, actor) => {
        const row = await store.load(tx, id);
        await store.permit(tx, actor, row, 'manage');
        return store.command(
          tx,
          actor,
          value?.requestId,
          'lifecycle',
          { id, input },
          integrationMetadataSchema,
          async () => {
            if (value && row.version !== value.expectedVersion) throw new McpError('conflict');
            if (row.lifecycle === 'deleted' || (lifecycle === 'active' && !row.credential))
              throw new McpError('integration-unavailable');
            if (row.lifecycle === lifecycle) return store.metadata(tx, actor, row);
            const recommendations = await watchIntegrationRecommendations(tx, id, () => mcpRecommendations(tx, id));
            await store.invalidate(tx, row);
            await tx.client.query(
              `UPDATE ${table(tx, 'integrations')} SET version=version+1,lifecycle=$2,credential=CASE WHEN $2 IN ('deleted','disconnected') THEN NULL ELSE credential END WHERE id=$1`,
              [id, lifecycle],
            );
            await recommendations();
            return store.metadata(tx, actor, await store.load(tx, id));
          },
        );
      });
    },
    replaceCredential(workspaceId: string, principal: McpPrincipal, id: string, input: unknown) {
      admitted();
      const value = z
        .strictObject({
          requestId: z.uuid().optional(),
          expectedVersion: z.number().int().positive().optional(),
          credential: mcpCredentialSchema,
          endpoint: z.string().optional(),
          expectedSecretVersion: z.number().int().positive().optional(),
        })
        .refine(value => (value.requestId ? !!value.expectedVersion : !!value.expectedSecretVersion))
        .parse(input);
      return store.authorized(workspaceId, principal, async (tx, actor) => {
        const row = await store.load(tx, id);
        await store.permit(tx, actor, row, 'manage');
        return store.command(
          tx,
          actor,
          value.requestId,
          'credential',
          { id, ...value },
          integrationMetadataSchema,
          async () => {
            if (
              row.lifecycle === 'deleted' ||
              (value.requestId
                ? row.version !== value.expectedVersion
                : row.secret_version !== value.expectedSecretVersion)
            )
              throw new McpError('conflict');
            const endpoint = endpointIdentity(value.endpoint ?? row.endpoint);
            rejectReflectedSecrets({ endpoint, name: row.name }, value.credential);
            const recommendations = await watchIntegrationRecommendations(tx, id, () => mcpRecommendations(tx, id));
            await store.invalidate(tx, row);
            const encrypted = store.cipher.encrypt(
              { workspaceId, integrationId: id, version: row.secret_version + 1, purpose: 'credential' },
              JSON.stringify(value.credential),
            );
            await tx.client.query(
              `UPDATE ${table(tx, 'integrations')} SET credential=$2,secret_version=secret_version+1,version=version+1,endpoint=$3,server_identity=$4,lifecycle='active',auth_method=$5,credential_expires_at=$6 WHERE id=$1`,
              [
                id,
                encrypted,
                endpoint,
                serverIdentity(endpoint),
                value.credential.kind,
                value.credential.kind === 'oauth' ? value.credential.expiresAt : null,
              ],
            );
            await recommendations();
            return store.metadata(tx, actor, await store.load(tx, id));
          },
        );
      });
    },
    async discover(
      workspaceId: string,
      principal: McpPrincipal,
      id: string,
      input?: { requestId: string; expectedVersion: number },
    ) {
      const command = input
        ? z.strictObject({ requestId: z.uuid(), expectedVersion: z.number().int().positive() }).parse(input)
        : null;
      const before = await store.authorized(workspaceId, principal, async (tx, actor) => {
        const row = await store.load(tx, id);
        await store.permit(tx, actor, row, 'manage');
        store.active(row);
        if (command) {
          const old = z
            .object({ digest: z.string(), result: z.array(policySchema) })
            .optional()
            .parse(
              (
                await tx.client.query(
                  `SELECT digest,result FROM ${table(tx, 'commands')} WHERE membership_id=$1 AND request_id=$2 AND kind='discover'`,
                  [actor.membershipId, command.requestId],
                )
              ).rows[0],
            );
          if (old) {
            if (old.digest !== digest(['discover', { id, ...command }])) throw new McpError('conflict');
            return { row, result: old.result };
          }
          if (row.version !== command.expectedVersion) throw new McpError('conflict');
        }
        return { row, result: null };
      });
      if (before.result) return before.result;
      const tools = await discoverPrepared(workspaceId, before.row);
      return store.authorized(workspaceId, principal, async (tx, actor) => {
        const row = await store.load(tx, id);
        await store.permit(tx, actor, row, 'manage');
        store.active(row);
        return store.command(
          tx,
          actor,
          command?.requestId,
          'discover',
          { id, ...command },
          z.array(policySchema),
          async () => {
            if (
              row.authorization_epoch !== before.row.authorization_epoch ||
              row.secret_version !== before.row.secret_version ||
              (command && row.version !== command.expectedVersion)
            )
              throw new McpError('conflict');
            await saveDiscovery(tx, row, tools);
            await tx.client.query(`UPDATE ${table(tx, 'integrations')} SET version=version+1 WHERE id=$1`, [id]);
            return policies(tx, id);
          },
        );
      });
    },
    tools(workspaceId: string, principal: McpPrincipal, id: string) {
      return store.authorized(workspaceId, principal, async (tx, actor) => {
        const row = await store.load(tx, id);
        await store.permit(tx, actor, row, 'read');
        return policies(tx, id);
      });
    },
    reviewTools(workspaceId: string, principal: McpPrincipal, id: string, input: unknown) {
      const toolsSchema = z
        .array(
          z.strictObject({
            name: z.string(),
            revision: z.string(),
            enabled: z.boolean(),
            standingException: z.boolean(),
          }),
        )
        .max(mcpLimits.discoveredTools);
      const command = Array.isArray(input)
        ? null
        : z
            .strictObject({ requestId: z.uuid(), expectedVersion: z.number().int().positive(), tools: toolsSchema })
            .parse(input);
      const value = command?.tools ?? toolsSchema.parse(input);
      return store.authorized(workspaceId, principal, async (tx, actor) => {
        const row = await store.load(tx, id);
        await store.permit(tx, actor, row, 'manage');
        store.active(row);
        return store.command(
          tx,
          actor,
          command?.requestId,
          'review',
          { id, input },
          z.array(policySchema),
          async () => {
            if (command && row.version !== command.expectedVersion) throw new McpError('conflict');
            const existing = await policies(tx, id);
            const recommendations = await watchIntegrationRecommendations(tx, id, () => mcpRecommendations(tx, id));
            if (new Set(value.map(tool => tool.name)).size !== value.length) throw new McpError('invalid-input');
            const enabled = new Set(existing.filter(policy => policy.enabled_revision).map(policy => policy.name));
            for (const tool of value) {
              const policy = existing.find(policy => policy.name === tool.name);
              if (
                !policy ||
                !policy.present ||
                policy.discovered_revision !== tool.revision ||
                (tool.enabled && policy.compatibility_reason) ||
                (!tool.enabled && tool.standingException)
              )
                throw new McpError('incompatible-tool');
              if (tool.enabled) enabled.add(tool.name);
              else enabled.delete(tool.name);
              await tx.client.query(
                `UPDATE ${table(tx, 'tool_policies')} SET enabled_revision=$3,standing_exception=$4,policy_version=policy_version+1 WHERE integration_id=$1 AND name=$2`,
                [id, tool.name, tool.enabled ? tool.revision : null, tool.standingException],
              );
            }
            if (enabled.size > mcpLimits.selectedTools) throw new McpError('limit');
            await tx.client.query(`UPDATE ${table(tx, 'integrations')} SET version=version+1 WHERE id=$1`, [id]);
            await recommendations();
            return policies(tx, id);
          },
        );
      });
    },
    setSelection(workspaceId: string, principal: McpPrincipal, input: unknown) {
      const value = z
        .strictObject({
          origin: mcpOriginSchema,
          expectedVersion: z.number().int().nonnegative(),
          integrationIds: z.array(z.uuid()).max(20),
        })
        .parse(input);
      return store.authorized(workspaceId, principal, async (tx, actor) => {
        await store.origin(tx, actor, value.origin, 'select');
        const old = await store.selection(tx, actor, value.origin);
        if (old.version !== value.expectedVersion || new Set(value.integrationIds).size !== value.integrationIds.length)
          throw new McpError('conflict');
        const bindings = [];
        for (const id of value.integrationIds) {
          const row = await store.load(tx, id);
          await store.permit(tx, actor, row, 'use');
          store.active(row);
          bindings.push({ integrationId: id, authorizationEpoch: row.authorization_epoch });
        }
        await tx.client.query(
          `INSERT INTO ${table(tx, 'selections')} (membership_id,origin_key,version,bindings) VALUES ($1,$2,$3,$4) ON CONFLICT (membership_id,origin_key) DO UPDATE SET version=EXCLUDED.version,bindings=EXCLUDED.bindings`,
          [
            actor.membershipId,
            originKey(value.origin),
            old.version + 1,
            JSON.stringify(bindingsSchema.parse(bindings)),
          ],
        );
        return { version: old.version + 1, bindings };
      });
    },
    selection(workspaceId: string, principal: McpPrincipal, origin: McpOrigin) {
      return store.authorized(workspaceId, principal, async (tx, actor) => {
        await store.origin(tx, actor, origin, 'read');
        return store.selection(tx, actor, origin);
      });
    },
    catalog(workspaceId: string, principal: McpPrincipal, origin: McpOrigin) {
      return store.authorized(workspaceId, principal, async (tx, actor) => {
        const authority = await store.origin(tx, actor, origin, 'catalog');
        const selection = await store.selection(tx, actor, origin);
        const tools = [];
        for (const binding of selection.bindings) {
          const row = await store.load(tx, binding.integrationId);
          await store.permit(tx, actor, row, 'use');
          store.active(row);
          if (binding.authorizationEpoch !== row.authorization_epoch) throw new AccessDenied();
          if (await store.barrier(tx, row.id)) continue;
          for (const policy of await policies(tx, row.id))
            if (
              policy.present &&
              !policy.compatibility_reason &&
              policy.enabled_revision === policy.discovered_revision &&
              allowed(authority, row, policy.name, policy.discovered_revision, selection.bindings)
            )
              tools.push({
                handle: digest([
                  'workspace-mcp-handle-v1',
                  actor.membershipId,
                  originKey(origin),
                  selection.version,
                  row.id,
                  row.authorization_epoch,
                  policy.name,
                  policy.discovered_revision,
                  policy.policy_version,
                ]),
                integrationId: row.id,
                integrationName: row.name,
                serverIdentity: row.server_identity,
                revision: policy.discovered_revision,
                tool: policy.tool,
              });
        }
        bounded(tools, mcpLimits.catalogBytes);
        return {
          selectionVersion: selection.version,
          tools,
          sources: selection.bindings.map(binding => ({
            kind: 'mcp-integration' as const,
            integrationId: binding.integrationId,
            authorizationEpoch: binding.authorizationEpoch,
          })),
        };
      });
    },
    async propose(workspaceId: string, principal: McpPrincipal, input: unknown) {
      dispatchEnabled();
      const value = z
        .strictObject({ id: z.uuid(), origin: mcpOriginSchema, handle: z.string(), arguments: jsonObjectSchema })
        .parse(input);
      const catalog = await service.catalog(workspaceId, principal, value.origin);
      const selected = catalog.tools.find(tool => tool.handle === value.handle);
      if (!selected) throw new AccessDenied();
      validateArguments(selected.tool, value.arguments);
      return store.authorized(workspaceId, principal, async (tx, actor) => {
        const row = await store.load(tx, selected.integrationId);
        await store.permit(tx, actor, row, 'use');
        store.active(row);
        const selection = await store.selection(tx, actor, value.origin);
        const authority = await store.origin(tx, actor, value.origin, 'propose');
        const policy = await readyTool(tx, row, selected.tool.name, selected.revision);
        const handle = digest([
          'workspace-mcp-handle-v1',
          actor.membershipId,
          originKey(value.origin),
          selection.version,
          row.id,
          row.authorization_epoch,
          policy.name,
          policy.discovered_revision,
          policy.policy_version,
        ]);
        if (
          handle !== value.handle ||
          !selection.bindings.some(
            binding => binding.integrationId === row.id && binding.authorizationEpoch === row.authorization_epoch,
          ) ||
          !allowed(authority, row, policy.name, policy.discovered_revision, selection.bindings)
        )
          throw new AccessDenied();
        if (await store.barrier(tx, row.id)) throw new McpError('integration-blocked');
        const sources = sourceUnion(authority.sources, [
          { kind: 'mcp-integration', integrationId: row.id, authorizationEpoch: row.authorization_epoch },
        ]);
        const requiresConsent =
          value.origin.kind === 'named-task' ||
          sources.some(
            source =>
              source.kind !== 'mcp-integration' ||
              source.integrationId !== row.id ||
              source.authorizationEpoch !== row.authorization_epoch,
          );
        const hash = digest([
          'workspace-mcp-action-v1',
          value.id,
          actor,
          value.origin,
          row.id,
          row.endpoint,
          row.authorization_epoch,
          selection.version,
          policy.name,
          policy.discovered_revision,
          policy.policy_version,
          value.arguments,
          sources,
          requiresConsent,
        ]);
        const previous = (
          await tx.client.query(
            `SELECT id,digest FROM ${table(tx, 'actions')} WHERE id=$1 OR (requester=$2 AND origin=$3)`,
            [value.id, actor, value.origin],
          )
        ).rows[0];
        if (previous) {
          const old = z.object({ id: z.uuid(), digest: z.string() }).parse(previous);
          if (old.id !== value.id || old.digest !== hash) throw new McpError('conflict');
          return actionView(tx, actor, await store.action(tx, old.id));
        }
        await tx.client.query(
          `INSERT INTO ${table(tx, 'actions')} (id,requester,origin,integration_id,authorization_epoch,selection_version,tool_name,tool_revision,policy_version,arguments,sources,digest,requires_consent) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [
            value.id,
            actor,
            value.origin,
            row.id,
            row.authorization_epoch,
            selection.version,
            policy.name,
            policy.discovered_revision,
            policy.policy_version,
            value.arguments,
            JSON.stringify(sources),
            hash,
            requiresConsent,
          ],
        );
        if (!requiresConsent && policy.standing_exception)
          await tx.client.query(
            `INSERT INTO ${table(tx, 'policy_evaluations')} (action_id,policy_version,digest) VALUES ($1,$2,$3)`,
            [value.id, policy.policy_version, hash],
          );
        return actionView(tx, actor, await store.action(tx, value.id));
      });
    },
    action(workspaceId: string, principal: McpPrincipal, id: string) {
      return store.authorized(workspaceId, principal, async (tx, actor) =>
        actionView(tx, actor, await store.action(tx, id)),
      );
    },
    actionForOrigin(workspaceId: string, principal: McpPrincipal, origin: McpOrigin) {
      return store.authorized(workspaceId, principal, async (tx, actor) => {
        await store.origin(tx, actor, origin, 'read');
        const found = z
          .object({ id: z.uuid() })
          .optional()
          .parse(
            (
              await tx.client.query(`SELECT id FROM ${table(tx, 'actions')} WHERE requester=$1 AND origin=$2`, [
                actor,
                mcpOriginSchema.parse(origin),
              ])
            ).rows[0],
          );
        return found ? actionView(tx, actor, await store.action(tx, found.id)) : null;
      });
    },
    actionStatus(workspaceId: string, principal: McpPrincipal, id: string, metadataOnly = false) {
      return store.authorized(workspaceId, principal, async (tx, actor) => {
        const action = await store.action(tx, id);
        if (
          !metadataOnly &&
          action.requester.membershipId === actor.membershipId &&
          action.requester.userId === actor.userId
        ) {
          try {
            return { kind: 'full' as const, action: await actionView(tx, actor, action) };
          } catch (error) {
            if (
              !(error instanceof AccessDenied) &&
              !(error instanceof McpError && error.code === 'integration-unavailable')
            )
              throw error;
          }
        }
        return recoveryView(tx, actor, action);
      });
    },
    async actions(workspaceId: string, principal: McpPrincipal, input: unknown) {
      const value = z
        .strictObject({ kind: z.enum(['chat', 'task', 'integration']), originId: z.uuid(), after: z.uuid().optional() })
        .parse(input);
      const ids = await store.authorized(workspaceId, principal, async (tx, actor) => {
        return z.array(z.object({ id: z.uuid() })).parse(
          (
            await tx.client.query(
              `SELECT a.id FROM ${table(tx, 'actions')} a JOIN ${table(tx, 'integrations')} c ON c.id=a.integration_id
          WHERE ($1::uuid IS NULL OR a.id>$1) AND (($2='integration' AND a.integration_id=$3::uuid) OR ($2='chat' AND a.origin->>'conversationId'=$3::text) OR ($2='task' AND a.origin->>'taskId'=$3::text))
          AND a.requester->>'membershipId'=$4 AND a.requester->>'userId'=$5 ORDER BY a.id LIMIT 51`,
              [value.after ?? null, value.kind, value.originId, actor.membershipId, actor.userId],
            )
          ).rows,
        );
      });
      const actions = [];
      for (const { id } of ids.slice(0, 50)) actions.push(await service.actionStatus(workspaceId, principal, id));
      return { actions, nextCursor: ids.length > 50 ? (ids[49]?.id ?? null) : null };
    },
    decide(workspaceId: string, principal: McpPrincipal, id: string, input: unknown) {
      const value = z
        .strictObject({ requestId: z.uuid().optional(), digest: z.string(), decision: z.enum(['approve', 'reject']) })
        .parse(input);
      return store.confirmation(workspaceId, principal, async (tx, actor) => {
        const action = await store.action(tx, id);
        await authorizeAction(tx, actor, action, 'read', false);
        await store.command(
          tx,
          actor,
          value.requestId,
          'decision',
          { id, ...value },
          z.object({ id: z.uuid() }),
          async () => {
            if (value.decision === 'approve') dispatchEnabled();
            await authorizeAction(tx, actor, action, 'approve');
            if (
              action.digest !== value.digest ||
              (
                await tx.client.query(
                  `SELECT 1 FROM ${table(tx, 'claims')} WHERE action_id=$1 UNION ALL SELECT 1 FROM ${table(tx, 'cancellations')} WHERE action_id=$1`,
                  [id],
                )
              ).rowCount
            )
              throw new McpError('conflict');
            const previous = decisionSchema
              .optional()
              .parse(
                (
                  await tx.client.query(`SELECT decision,digest FROM ${table(tx, 'decisions')} WHERE action_id=$1`, [
                    id,
                  ])
                ).rows[0],
              );
            if (previous && (previous.digest !== value.digest || previous.decision !== value.decision))
              throw new McpError('conflict');
            if (!previous)
              await tx.client.query(
                `INSERT INTO ${table(tx, 'decisions')} (action_id,membership_id,digest,decision) VALUES ($1,$2,$3,$4)`,
                [id, actor.membershipId, value.digest, value.decision],
              );
            return { id };
          },
        );
        return actionView(tx, actor, action);
      });
    },
    cancel(workspaceId: string, principal: McpPrincipal, id: string) {
      return store.authorized(workspaceId, principal, async (tx, actor) => {
        const action = await store.action(tx, id);
        if (action.requester.membershipId !== actor.membershipId) throw new AccessDenied();
        if ((await tx.client.query(`SELECT 1 FROM ${table(tx, 'claims')} WHERE action_id=$1`, [id])).rowCount)
          throw new McpError('conflict');
        await tx.client.query(
          `INSERT INTO ${table(tx, 'cancellations')} (action_id,membership_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
          [id, actor.membershipId],
        );
        return { id, status: 'cancelled-before-dispatch' };
      });
    },
    async dispatch(workspaceId: string, id: string) {
      dispatchEnabled();
      const prepared = await store.transaction(workspaceId, async tx => {
        const action = await store.action(tx, id);
        const claim = (await tx.client.query(`SELECT 1 FROM ${table(tx, 'claims')} WHERE action_id=$1`, [id])).rowCount;
        if (claim) return null;
        const { row } = await authorizeAction(tx, action.requester, action, 'dispatch');
        return { row, action };
      });
      if (!prepared) {
        await service.recover(workspaceId);
        return service.dispatchStatus(workspaceId, id);
      }
      const discovered = await discoverPrepared(workspaceId, prepared.row);
      await store.transaction(workspaceId, async tx => {
        const row = await store.load(tx, prepared.row.id);
        if (
          row.authorization_epoch !== prepared.row.authorization_epoch ||
          row.secret_version !== prepared.row.secret_version
        )
          throw new McpError('conflict');
        await saveDiscovery(tx, row, discovered);
      });
      const claimed = await store.transaction(workspaceId, async tx => {
        if ((await tx.client.query(`SELECT 1 FROM ${table(tx, 'claims')} WHERE action_id=$1`, [id])).rowCount)
          return null;
        const action = await store.action(tx, id);
        const { row, policy } = await authorizeAction(tx, action.requester, action, 'dispatch');
        if (!policy) throw new AccessDenied();
        if (await store.barrier(tx, row.id)) throw new McpError('integration-blocked');
        const decision = decisionSchema
          .optional()
          .parse(
            (await tx.client.query(`SELECT decision,digest FROM ${table(tx, 'decisions')} WHERE action_id=$1`, [id]))
              .rows[0],
          );
        if (
          decision?.decision === 'reject' ||
          (await tx.client.query(`SELECT 1 FROM ${table(tx, 'cancellations')} WHERE action_id=$1`, [id])).rowCount
        )
          throw new McpError('conflict');
        if (decision?.decision !== 'approve' && (action.requires_consent || !policy.standing_exception))
          throw new McpError('approval-required');
        const credential = store.credential(workspaceId, row);
        if (credential.kind === 'oauth' && Date.parse(credential.expiresAt) <= Date.now())
          throw new McpError('integration-unavailable');
        const token = randomUUID();
        const { deadline } = z
          .object({ deadline: z.date() })
          .parse(
            (
              await tx.client.query(
                `INSERT INTO ${table(tx, 'claims')} (action_id,integration_id,token) VALUES ($1,$2,$3) RETURNING deadline`,
                [id, row.id, token],
              )
            ).rows[0],
          );
        return { action, row, tool: policy.tool, credential, token, deadline: deadline.getTime() };
      });
      if (!claimed) return service.dispatchStatus(workspaceId, id);
      const authorize = async () => {
        await store.transaction(workspaceId, async tx => {
          await authorizeAction(tx, claimed.action.requester, claimed.action, 'dispatch');
          if (
            !(
              await tx.client.query(
                `SELECT 1 FROM ${table(tx, 'claims')} c WHERE c.action_id=$1 AND c.token=$2 AND c.deadline>clock_timestamp() AND NOT EXISTS (SELECT 1 FROM ${table(tx, 'receipts')} r WHERE r.action_id=c.action_id)`,
                [id, claimed.token],
              )
            ).rowCount
          )
            throw new McpError('expired');
        });
      };
      let result = null;
      try {
        const response = await timed(claimed.deadline, async signal => {
          await authorize();
          signal.throwIfAborted();
          if (Date.now() >= claimed.deadline) throw new McpError('expired');
          return options.protocol.call({
            endpoint: claimed.row.endpoint,
            credential: claimed.credential,
            tool: claimed.tool,
            arguments: claimed.action.arguments,
            requestId: id,
            deadline: claimed.deadline,
            authorize,
            signal,
          });
        });
        bounded(response, mcpLimits.responseBytes);
        rejectReflectedSecrets(response, claimed.credential);
        const parsed = mcpResultSchema.parse(response);
        if (parsed.isError) throw new Error();
        validateOutput(claimed.tool, parsed.structuredContent);
        result = parsed;
      } catch {
        result = null;
      }
      await store.transaction(workspaceId, async tx => {
        await store.load(tx, claimed.row.id);
        await tx.client.query(
          `INSERT INTO ${table(tx, 'receipts')} (action_id,status,result,sources) SELECT $1,$2,$3,$4 FROM ${table(tx, 'claims')} WHERE action_id=$1 AND token=$5 ON CONFLICT DO NOTHING`,
          [id, result ? 'succeeded' : 'outcome-unknown', result, JSON.stringify(claimed.action.sources), claimed.token],
        );
      });
      return service.dispatchStatus(workspaceId, id);
    },
    dispatchStatus(workspaceId: string, id: string) {
      return store.transaction(workspaceId, async tx => {
        await store.action(tx, id);
        const receipt = receiptSchema
          .optional()
          .parse(
            (await tx.client.query(`SELECT status,result FROM ${table(tx, 'receipts')} WHERE action_id=$1`, [id]))
              .rows[0],
          );
        return {
          id,
          status:
            receipt?.status ??
            ((await tx.client.query(`SELECT 1 FROM ${table(tx, 'claims')} WHERE action_id=$1`, [id])).rowCount
              ? 'dispatched'
              : 'pending'),
        };
      });
    },
    recover(workspaceId: string) {
      return store.transaction(workspaceId, async tx => {
        const result = await tx.client.query(
          `INSERT INTO ${table(tx, 'receipts')} (action_id,status,sources) SELECT c.action_id,'outcome-unknown',a.sources FROM ${table(tx, 'claims')} c JOIN ${table(tx, 'actions')} a ON a.id=c.action_id WHERE c.deadline<=clock_timestamp() AND NOT EXISTS (SELECT 1 FROM ${table(tx, 'receipts')} r WHERE r.action_id=c.action_id) ON CONFLICT DO NOTHING RETURNING action_id`,
        );
        return { recovered: result.rowCount ?? 0 };
      });
    },
    async recoverAction(workspaceId: string, principal: McpPrincipal, id: string) {
      await store.authorized(workspaceId, principal, async (tx, actor) => {
        const action = await store.action(tx, id);
        if (actor.membershipId !== action.requester.membershipId || actor.userId !== action.requester.userId)
          throw new AccessDenied();
        await tx.client.query(
          `INSERT INTO ${table(tx, 'receipts')} (action_id,status,sources) SELECT c.action_id,'outcome-unknown',a.sources FROM ${table(tx, 'claims')} c JOIN ${table(tx, 'actions')} a ON a.id=c.action_id WHERE c.action_id=$1 AND c.deadline<=clock_timestamp() ON CONFLICT DO NOTHING`,
          [id],
        );
      });
      return service.dispatchStatus(workspaceId, id);
    },
    recoveryActions(workspaceId: string, principal: McpPrincipal, integrationId: string) {
      return store.authorized(workspaceId, principal, async (tx, actor) => {
        const integration = await store.load(tx, integrationId);
        await store.permit(tx, actor, integration, 'read');
        return z
          .array(
            z.object({
              id: z.uuid(),
              status: z.enum(['dispatched', 'outcome-unknown']),
              created_at: z.date(),
              administrative: z.boolean(),
            }),
          )
          .parse(
            (
              await tx.client.query(
                `SELECT a.id,coalesce(r.status,'dispatched') AS status,c.created_at,(a.requester->>'membershipId'<>$2) AS administrative FROM ${table(tx, 'claims')} c JOIN ${table(tx, 'actions')} a ON a.id=c.action_id LEFT JOIN ${table(tx, 'receipts')} r ON r.action_id=c.action_id
          WHERE c.integration_id=$1 AND (r.action_id IS NULL OR r.status='outcome-unknown')
          AND NOT EXISTS (SELECT 1 FROM ${table(tx, 'reconciliations')} h WHERE h.action_id=a.id AND h.observation<>'still-unknown')
          AND a.requester->>'membershipId'=$2 AND a.requester->>'userId'=$3 ORDER BY c.created_at,a.id LIMIT 100`,
                [integrationId, actor.membershipId, actor.userId],
              )
            ).rows,
          );
      });
    },
    reconcile(workspaceId: string, principal: McpPrincipal, id: string, input: unknown) {
      const value = z
        .strictObject({
          requestId: z.uuid().optional(),
          digest: z.string().optional(),
          observation: z.enum(['completed', 'not-performed', 'still-unknown']),
          notes: z.string().min(1).max(8192),
        })
        .refine(value => !value.requestId || !!value.digest)
        .parse(input);
      if (Buffer.byteLength(value.notes) > 8192) throw new McpError('limit');
      return store.confirmation(workspaceId, principal, async (tx, actor) => {
        const action = await store.action(tx, id);
        const administrative =
          actor.membershipId !== action.requester.membershipId || actor.userId !== action.requester.userId;
        if (administrative) throw new AccessDenied();
        return store.command(
          tx,
          actor,
          value.requestId,
          'reconcile',
          { id, ...value },
          z.object({
            id: z.uuid(),
            actionId: z.uuid(),
            observation: z.enum(['completed', 'not-performed', 'still-unknown']),
            administrative: z.boolean(),
          }),
          async () => {
            if (value.digest && value.digest !== action.digest) throw new McpError('conflict');
            if (
              !(
                await tx.client.query(
                  `SELECT 1 FROM ${table(tx, 'receipts')} WHERE action_id=$1 AND status='outcome-unknown'`,
                  [id],
                )
              ).rowCount ||
              (
                await tx.client.query(
                  `SELECT 1 FROM ${table(tx, 'reconciliations')} WHERE action_id=$1 AND observation<>'still-unknown'`,
                  [id],
                )
              ).rowCount
            )
              throw new McpError('conflict');
            const observationId = randomUUID();
            await tx.client.query(
              `INSERT INTO ${table(tx, 'reconciliations')} (id,action_id,membership_id,observation,administrative,notes) VALUES ($1,$2,$3,$4,$5,$6)`,
              [observationId, id, actor.membershipId, value.observation, administrative, value.notes],
            );
            return { id: observationId, actionId: id, observation: value.observation, administrative };
          },
        );
      });
    },
    requireSource(
      workspaceId: string,
      principal: McpPrincipal,
      source: { kind: 'mcp-integration'; integrationId: string; authorizationEpoch: number },
    ) {
      return store.authorized(workspaceId, principal, (tx, actor) => store.sources(tx, actor, [source]));
    },
    ...oauthMethods(options, store),
    ...selectionMethods(options, store),
  };
  return service;
}
async function timed<T>(deadline: number, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (Date.now() >= deadline) throw new McpError('expired');
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => {
          controller.abort();
          reject(new McpError('outcome-unknown'));
        },
        Math.max(0, deadline - Date.now()),
      );
    });
    return await Promise.race([operation(controller.signal), timeout]);
  } finally {
    controller.abort();
    clearTimeout(timer);
  }
}
export type WorkspaceMcpService = ReturnType<typeof createWorkspaceMcp>;
