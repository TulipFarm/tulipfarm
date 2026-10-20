import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AccessDenied, denyMcpEgress, type HumanActor } from '@tulipfarm/access';
import type { AccountRuntime, createAtlassianAccounts } from './accounts.ts';
import { AtlassianMcpError, createAtlassianMcpClient, type AtlassianMcpBinding } from './mcp.ts';
import { ProviderError } from './rest.ts';
import { rejectReflectedCredentials } from './account-provider.ts';
import {
  boundedResult,
  canonical,
  createSourceSchema,
  digest,
  isWrite,
  OperationError,
  operationRequestSchema,
  proposalRequestSchema,
} from './operation-contracts.ts';
import {
  authorized,
  authorizeAccount,
  decision,
  freshProposal,
  loadProposal,
  loadSource,
  proposalLock,
  proposalRowSchema,
  proposalView,
  receipt,
  sourceRowSchema,
  sourceView,
  table,
} from './operation-store.ts';
import {
  dispatchOperation,
  operationConfiguration,
  requireMatchingSource,
  trustedBindingsSchema,
} from './operation-provider.ts';
import { recordRecommendationChange } from '@tulipfarm/workspace-storage/recommendations';

import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
export * from './operation-contracts.ts';
export { trustedOperationBindings } from './operation-provider.ts';
export function createAtlassianOperations(options: {
  runtime: AccountRuntime;
  accounts: ReturnType<typeof createAtlassianAccounts>;
  bindings?: readonly AtlassianMcpBinding[];
  fetcher?: typeof fetch;
}) {
  const bindings = trustedBindingsSchema.parse(options.bindings ?? []);
  const fetcher = options.fetcher ?? fetch;
  const access = authorized(options.runtime);
  const credential = (workspaceId: string, userId: string | HumanActor, accountId: string) =>
    options.accounts.withAccessToken(workspaceId, userId, accountId, async value => value);
  async function context(workspaceId: string, userId: string | HumanActor, sourceId: string) {
    const source = await access(
      workspaceId,
      userId,
      async (tx, actor) => (await loadSource(tx, actor, sourceId)).source,
    );
    const token = await credential(workspaceId, userId, source.account_id);
    return { source, token };
  }
  return {
    async createSource(workspaceId: string, userId: string, input: unknown) {
      const value = createSourceSchema.parse(input);
      await credential(workspaceId, userId, value.accountId);
      return access(workspaceId, userId, async (tx, actor) => {
        const account = await authorizeAccount(tx, actor, value.accountId);
        const protocol =
          value.binding.kind === 'trello'
            ? 'trello'
            : value.binding.kind === 'confluence-trash'
              ? 'atlassian-rest'
              : 'atlassian-mcp';
        if (account.protocol !== protocol) throw new OperationError('operation-conflict');
        const binding = value.binding;
        if (binding.kind === 'confluence-trash' && !account.resources.some(resource => resource.id === binding.cloudId))
          throw new AccessDenied();
        await proposalLock(tx, actor.membershipId);
        const count = z
          .number()
          .parse(
            (
              await tx.client.query(
                `SELECT count(*)::integer AS count FROM ${table(tx, 'sources')} WHERE membership_id=$1`,
                [actor.membershipId],
              )
            ).rows[0]?.count,
          );
        if (count >= 100) throw new OperationError('operation-limit');
        const id = randomUUID();
        await tx.client.query(
          `INSERT INTO ${table(tx, 'sources')} (id,account_id,membership_id,name,binding) VALUES ($1,$2,$3,$4,$5)`,
          [id, value.accountId, actor.membershipId, value.name, value.binding],
        );
        await recordRecommendationChange(tx, {
          id: randomUUID(),
          kind: 'integration',
          sourceId: id,
          membershipIds: [actor.membershipId],
        });
        return { id, ...value, enabled: true };
      });
    },
    async sources(workspaceId: string, userId: string | HumanActor) {
      return access(workspaceId, userId, async (tx, actor) => {
        const rows = z
          .array(sourceRowSchema)
          .parse(
            (
              await tx.client.query(
                `SELECT * FROM ${table(tx, 'sources')} WHERE membership_id=$1 ORDER BY created_at,id LIMIT 100`,
                [actor.membershipId],
              )
            ).rows,
          );
        const sources = [];
        for (const row of rows) {
          try {
            await authorizeAccount(tx, actor, row.account_id);
            sources.push(sourceView(row));
          } catch (error) {
            if (!(error instanceof AccessDenied) && !(error instanceof OperationError)) throw error;
          }
        }
        return {
          sources,
          mcp: {
            enabled: bindings.length > 0,
            explanation: bindings.length
              ? 'Only operator-reviewed tool contracts are enabled.'
              : 'MCP operations are disabled until an operator reviews the authenticated catalog and configures trusted contract digests.',
          },
        };
      });
    },
    async disableSource(workspaceId: string, userId: string, sourceId: string) {
      return access(workspaceId, userId, async (tx, actor) => {
        const { source } = await loadSource(tx, actor, sourceId, true);
        const changed = await tx.client.query(
          `UPDATE ${table(tx, 'sources')} SET enabled=false WHERE id=$1 AND enabled RETURNING id`,
          [source.id],
        );
        if (changed.rowCount)
          await recordRecommendationChange(tx, {
            id: randomUUID(),
            kind: 'integration',
            sourceId: source.id,
            membershipIds: [actor.membershipId],
            invalidate: true,
          });
        return { ...sourceView(source), enabled: false };
      });
    },
    async qualify(workspaceId: string, userId: string, sourceId: string) {
      const { source, token } = await context(workspaceId, userId, sourceId);
      if (source.binding.kind !== 'jira' && source.binding.kind !== 'confluence')
        throw new OperationError('operation-conflict');
      const client = createAtlassianMcpClient({
        cloudId: source.binding.cloudId,
        context: { workspaceId, requesterId: userId },
        token: token.accessToken,
        bindings: [],
        authorize: async () => false,
        fetcher,
      });
      try {
        const catalog = await client.discover();
        await access(workspaceId, userId, async (tx, actor) => {
          const current = await loadSource(tx, actor, sourceId);
          if (
            current.account.generation !== token.generation ||
            actor.membershipId !== token.membershipId ||
            !current.account.expires_at ||
            current.account.expires_at.getTime() <= Date.now()
          )
            throw new OperationError('operation-conflict');
        });
        const value = {
          identityQualification: 'grant-bound-needs-qualification',
          executionQualification: 'operator-review-required',
          catalog,
        };
        rejectReflectedCredentials(value, [token.accessToken]);
        return boundedResult(value);
      } finally {
        await client.close();
      }
    },
    async read(workspaceId: string, userId: string | HumanActor, input: unknown) {
      denyMcpEgress();
      const value = operationRequestSchema.parse(input);
      if (isWrite(value.operation)) throw new OperationError('operation-read-required');
      const { source, token } = await context(workspaceId, userId, value.sourceId);
      operationConfiguration(bindings, value.operation);
      const authorize = () =>
        access(workspaceId, userId, async (tx, actor) => {
          const current = await loadSource(tx, actor, source.id);
          if (
            current.account.generation !== token.generation ||
            current.account.grants_version !== token.grantsVersion ||
            actor.membershipId !== token.membershipId ||
            !current.account.expires_at ||
            current.account.expires_at.getTime() <= Date.now()
          )
            throw new OperationError('operation-conflict');
          return true;
        });
      const result = await dispatchOperation({
        workspaceId,
        userId: typeof userId === 'string' ? userId : userId.userId,
        binding: source.binding,
        operation: value.operation,
        token: token.accessToken,
        bindings,
        authorize,
        fetcher,
      });
      await authorize();
      rejectReflectedCredentials(result, [token.accessToken]);
      return boundedResult(result);
    },
    async propose(workspaceId: string, userId: string | HumanActor, input: unknown) {
      denyMcpEgress();
      const value = proposalRequestSchema.parse(input);
      if (!isWrite(value.operation)) throw new OperationError('operation-write-required');
      const configurationDigest = operationConfiguration(bindings, value.operation);
      const { token } = await context(workspaceId, userId, value.sourceId);
      return access(workspaceId, userId, async (tx, actor) => {
        await proposalLock(tx, `${actor.membershipId}:${value.commandId}`);
        const { source, account } = await loadSource(tx, actor, value.sourceId);
        requireMatchingSource(source.binding, value.operation);
        if (
          account.generation !== token.generation ||
          account.grants_version !== token.grantsVersion ||
          actor.membershipId !== token.membershipId
        )
          throw new OperationError('operation-conflict');
        const previous = proposalRowSchema
          .optional()
          .parse(
            (
              await tx.client.query(
                `SELECT *,expires_at<=clock_timestamp() AS expired FROM ${table(tx, 'proposals')} WHERE membership_id=$1 AND command_id=$2`,
                [actor.membershipId, value.commandId],
              )
            ).rows[0],
          );
        if (previous) {
          if (previous.source_id !== source.id || canonical(previous.operation) !== canonical(value.operation))
            throw new OperationError('operation-conflict');
          return proposalView(tx, previous, source);
        }
        await proposalLock(tx, actor.membershipId);
        const count = z
          .number()
          .parse(
            (
              await tx.client.query(
                `SELECT count(*)::integer AS count FROM ${table(tx, 'proposals')} WHERE membership_id=$1 AND created_at>clock_timestamp()-interval '1 day'`,
                [actor.membershipId],
              )
            ).rows[0]?.count,
          );
        if (count >= 1000) throw new OperationError('operation-limit');
        const id = randomUUID();
        const actionDigest = digest({
          workspaceId,
          membershipId: actor.membershipId,
          id,
          source: sourceView(source),
          operation: value.operation,
          generation: account.generation,
          grantsVersion: account.grants_version,
          configurationDigest,
        });
        await tx.client.query(
          `INSERT INTO ${table(tx, 'proposals')} (id,source_id,membership_id,command_id,operation,account_generation,grants_version,configuration_digest,digest) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            id,
            source.id,
            actor.membershipId,
            value.commandId,
            value.operation,
            account.generation,
            account.grants_version,
            configurationDigest,
            actionDigest,
          ],
        );
        return proposalView(tx, await loadProposal(tx, actor, id), source);
      });
    },
    async proposal(workspaceId: string, userId: string | HumanActor, proposalId: string) {
      return access(workspaceId, userId, async (tx, actor) => {
        const row = await loadProposal(tx, actor, proposalId);
        const { source } = await loadSource(tx, actor, row.source_id, true);
        return proposalView(tx, row, source);
      });
    },
    async execute(workspaceId: string, userId: string | HumanActor, proposalId: string) {
      denyMcpEgress();
      const prepared = await access(workspaceId, userId, async (tx, actor) => {
        const row = await loadProposal(tx, actor, proposalId);
        const { source } = await loadSource(tx, actor, row.source_id);
        const existing = await receipt(tx, row.id);
        if (!existing) await freshProposal(tx, actor, row);
        return { row, source, existing };
      });
      if (prepared.existing) return prepared.existing;
      const token = await credential(workspaceId, userId, prepared.source.account_id);
      const claimed = await access(workspaceId, userId, async (tx, actor) => {
        await proposalLock(tx, proposalId);
        const row = await loadProposal(tx, actor, proposalId);
        const { source, account } = await freshProposal(tx, actor, row);
        const existing = await receipt(tx, row.id);
        if (existing) return { kind: 'existing' as const, receipt: existing };
        if (
          operationConfiguration(bindings, row.operation) !== row.configuration_digest ||
          account.generation !== token.generation ||
          token.membershipId !== actor.membershipId
        )
          throw new OperationError('operation-conflict');
        if ((await decision(tx, row.id)) !== 'approve') throw new OperationError('operation-approval-required');
        await tx.client.query(`INSERT INTO ${table(tx, 'receipts')} (proposal_id) VALUES ($1)`, [row.id]);
        return { kind: 'claimed' as const, row, source };
      });
      if (claimed.kind === 'existing') return claimed.receipt;
      const authorize = () =>
        access(workspaceId, userId, async (tx, actor) => {
          const row = await loadProposal(tx, actor, proposalId);
          const { account } = await freshProposal(tx, actor, row);
          if (
            account.generation !== token.generation ||
            account.grants_version !== token.grantsVersion ||
            token.membershipId !== actor.membershipId ||
            (await receipt(tx, row.id))?.status !== 'executing' ||
            (await decision(tx, row.id)) !== 'approve'
          )
            throw new OperationError('operation-conflict');
          return true;
        });
      let status: 'succeeded' | 'failed' | 'outcome-unknown' = 'outcome-unknown';
      let result: ReturnType<typeof boundedResult> | null = null;
      try {
        const output = await dispatchOperation({
          workspaceId,
          userId: typeof userId === 'string' ? userId : userId.userId,
          binding: claimed.source.binding,
          operation: claimed.row.operation,
          token: token.accessToken,
          bindings,
          authorize,
          fetcher,
        });
        await authorize();
        rejectReflectedCredentials(output, [token.accessToken]);
        result = boundedResult(output);
        status = 'succeeded';
      } catch (error) {
        status =
          (error instanceof ProviderError || error instanceof AtlassianMcpError) && error.code !== 'outcome-unknown'
            ? 'failed'
            : 'outcome-unknown';
      }
      await options.runtime.transaction(workspaceId, commonCompatibility, async tx => {
        await tx.client.query(
          `UPDATE ${table(tx, 'receipts')} SET status=$2,result=$3,error=$4 WHERE proposal_id=$1 AND status='executing'`,
          [
            proposalId,
            status,
            result,
            status === 'succeeded'
              ? null
              : status === 'failed'
                ? 'provider-request-failed'
                : 'provider-outcome-unknown',
          ],
        );
      });
      return access(workspaceId, userId, async (tx, actor) => {
        const { account } = await loadSource(tx, actor, claimed.source.id);
        if (
          account.generation !== token.generation ||
          account.grants_version !== token.grantsVersion ||
          actor.membershipId !== token.membershipId
        )
          throw new OperationError('operation-conflict');
        return receipt(tx, proposalId);
      });
    },
  };
}
