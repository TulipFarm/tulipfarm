import { z } from 'zod';
import { publicWebResultSchema } from '@tulipfarm/conversations/contracts';
import { AccessDenied, type HumanActor, type SourceDependency } from '@tulipfarm/access';
import { requiredScopes } from '@tulipfarm/google-workspace/operations';
import { googleOperationSchema } from '@tulipfarm/google-workspace/operation-contracts';
import { canonicalJson } from '@tulipfarm/tables/canonical';
import { blockedTableProposalSchema } from '@tulipfarm/tables/proposal-contracts';
import { referencedRecordIds } from '@tulipfarm/tables/query';
import { activeGeneration } from '@tulipfarm/tables/store';
import type { FrameworkCall } from './tools.ts';
import { documentUpload } from './google-tools.ts';
import { relation, type AgentTransaction } from './store.ts';
import {
  agentQueryErrorSchema,
  agentQueryRecordListSchema,
  agentQuerySummarySchema,
  agentReferenceChoicesSchema,
  agentStaleRevisionSchema,
} from './record-contracts.ts';

/** Linked tables whose rows shaped a version 2 query result: filtered link targets, offered name choices, or a resolved reference. */
export async function queryTargetTables(
  tx: AgentTransaction,
  call: { tool: string; tableId: string },
  result: unknown,
) {
  if (call.tool !== 'rows.list' && call.tool !== 'rows.summarize' && call.tool !== 'rows.resolveReference') return [];
  const resolved = agentReferenceChoicesSchema.safeParse(result);
  if (resolved.success) return [resolved.data.targetTableId];
  const page = z.union([agentQueryRecordListSchema, agentQuerySummarySchema]).safeParse(result);
  const failed = agentQueryErrorSchema.safeParse(result);
  if (!page.success && !failed.success) return [];
  const definition = (await activeGeneration(tx, call.tableId)).definition;
  const fieldIds = page.success
    ? referencedRecordIds(definition, page.data.query.where).map(item => item.fieldId)
    : (failed.data?.issues.flatMap(issue => (issue.choices?.length && issue.fieldId ? [issue.fieldId] : [])) ?? []);
  return [
    ...new Set(
      fieldIds.flatMap(id => {
        const field = definition.fields.find(item => item.id === id);
        return field?.kind === 'relationship' ? [field.targetTableId] : [];
      }),
    ),
  ].sort();
}

async function atlassianSource(tx: AgentTransaction, actor: HumanActor, id: string) {
  const row = z
    .object({
      account_id: z.uuid(),
      generation: z.number().int(),
      grants_version: z.number().int(),
      binding: z.unknown(),
    })
    .optional()
    .parse(
      (
        await tx.client.query(
          `SELECT s.account_id,s.binding,a.generation,a.grants_version FROM ${relation(tx, 'tf_atlassian_sources')} s JOIN ${relation(tx, 'tf_atlassian_accounts')} a ON a.id=s.account_id WHERE s.id=$1 AND s.membership_id=$2`,
          [id, actor.membershipId],
        )
      ).rows[0],
    );
  if (!row) throw new AccessDenied();
  return {
    kind: 'atlassian-source' as const,
    sourceId: id,
    accountId: row.account_id,
    membershipId: actor.membershipId,
    generation: row.generation,
    grantsVersion: row.grants_version,
    binding: canonicalJson(row.binding),
  };
}

export async function providerSources(
  tx: AgentTransaction,
  actor: HumanActor,
  call: FrameworkCall | McpProvenanceCall,
): Promise<SourceDependency[]> {
  switch (call.tool) {
    case 'mcp.call':
    case 'mcp.search':
    case 'mcp.describe':
      throw new AccessDenied();
    case 'atlassian.sources': {
      const rows = z
        .array(z.object({ id: z.uuid() }))
        .parse(
          (
            await tx.client.query(
              `SELECT id FROM ${relation(tx, 'tf_atlassian_sources')} WHERE membership_id=$1 ORDER BY created_at,id LIMIT 100`,
              [actor.membershipId],
            )
          ).rows,
        );
      return Promise.all(rows.map(row => atlassianSource(tx, actor, row.id)));
    }
    case 'github.issue.read': {
      const row = z
        .object({ generation: z.number().int(), grants_version: z.number().int() })
        .parse(
          (
            await tx.client.query(
              `SELECT generation,grants_version FROM ${relation(tx, 'tf_integrations')} WHERE id=$1`,
              [call.integrationId],
            )
          ).rows[0],
        );
      return [
        {
          kind: 'github-source',
          integrationId: call.integrationId,
          sourceId: call.sourceId,
          generation: row.generation,
          grantsVersion: row.grants_version,
        },
      ];
    }
    case 'atlassian.read':
    case 'atlassian.propose':
      return [await atlassianSource(tx, actor, call.sourceId)];
    case 'atlassian.proposal':
    case 'atlassian.execute': {
      const row = z
        .object({ source_id: z.uuid(), account_generation: z.number().int(), grants_version: z.number().int() })
        .parse(
          (
            await tx.client.query(
              `SELECT source_id,account_generation,grants_version FROM ${relation(tx, 'tf_atlassian_proposals')} WHERE id=$1 AND membership_id=$2`,
              [call.proposalId, actor.membershipId],
            )
          ).rows[0],
        );
      return [
        {
          ...(await atlassianSource(tx, actor, row.source_id)),
          generation: row.account_generation,
          grantsVersion: row.grants_version,
        },
      ];
    }
    case 'google.read':
    case 'google.propose': {
      const row = z
        .object({ id: z.uuid(), account_id: z.string(), generation: z.number().int(), scopes: z.array(z.string()) })
        .optional()
        .parse(
          (
            await tx.client.query(
              `SELECT id,account_id,generation,scopes FROM ${relation(tx, 'tf_google_integrations')} WHERE membership_id=$1 AND user_id=$2 AND status='connected'`,
              [actor.membershipId, actor.userId],
            )
          ).rows[0],
        );
      const operation =
        call.operation ?? (call.tool === 'google.propose' && call.document ? documentUpload(call.document) : undefined);
      if (!row || !operation) return [];
      return [
        {
          kind: 'google-integration',
          integrationId: row.id,
          accountId: row.account_id,
          generation: row.generation,
          membershipId: actor.membershipId,
          scopes: [...new Set(row.scopes)].sort(),
          requiredScopes: requiredScopes(operation),
        },
      ];
    }
    case 'google.status':
    case 'google.execute': {
      const row = z
        .object({
          integration_id: z.uuid(),
          account_id: z.string(),
          generation: z.number().int(),
          scopes: z.array(z.string()),
          operation: googleOperationSchema,
        })
        .optional()
        .parse(
          (
            await tx.client.query(
              `SELECT integration_id,account_id,generation,scopes,operation FROM ${relation(tx, 'tf_google_proposals')} WHERE id=$1 AND membership_id=$2 AND user_id=$3`,
              [call.proposalId, actor.membershipId, actor.userId],
            )
          ).rows[0],
        );
      if (!row) throw new AccessDenied();
      return [
        {
          kind: 'google-integration',
          integrationId: row.integration_id,
          accountId: row.account_id,
          generation: row.generation,
          membershipId: actor.membershipId,
          scopes: row.scopes,
          requiredScopes: requiredScopes(row.operation),
        },
      ];
    }
    default:
      return [];
  }
}

const ids = z.array(z.object({ id: z.uuid() }));
type McpProvenanceCall = { tool: 'mcp.call' | 'mcp.search' | 'mcp.describe' };
export async function resultSources(
  tx: AgentTransaction,
  call: FrameworkCall | McpProvenanceCall,
  result: unknown,
): Promise<SourceDependency[]> {
  switch (call.tool) {
    case 'mcp.call':
    case 'mcp.search':
    case 'mcp.describe':
      throw new AccessDenied();
    case 'tables.propose': {
      const blocked = blockedTableProposalSchema.safeParse(result);
      return blocked.success
        ? [{ kind: 'table-rows', tableId: blocked.data.tableId, revision: blocked.data.revision }]
        : [];
    }
    case 'tables.definitions':
      return z
        .object({ tables: z.array(z.object({ id: z.uuid(), revision: z.string() })) })
        .parse(result)
        .tables.map(item => ({ kind: 'table-rows', tableId: item.id, revision: item.revision }));
    case 'rows.page':
      return [{ kind: 'table-rows', tableId: call.tableId, revision: call.revision }];
    case 'rows.reverse':
      return [];
    case 'rows.list':
    case 'rows.summarize':
    case 'rows.resolveReference': {
      if (agentStaleRevisionSchema.safeParse(result).success) return [];
      const targets = await queryTargetTables(tx, call, result);
      const linked = await Promise.all(
        targets.map(async tableId => ({
          kind: 'table-rows' as const,
          tableId,
          revision: (await activeGeneration(tx, tableId)).revision,
        })),
      );
      return [{ kind: 'table-rows', tableId: call.tableId, revision: call.expectedAppliedRevision }, ...linked];
    }
    case 'rows.get':
    case 'rows.create':
    case 'rows.create.batch':
    case 'rows.update':
      return [{ kind: 'table-rows', tableId: call.tableId, revision: call.expectedAppliedRevision }];
    case 'rows.delete':
      return [];
    case 'github.issue.read':
      return [];
    case 'github.personal.account':
    case 'github.personal.read':
    case 'github.personal.download':
    case 'github.personal.propose':
    case 'github.personal.execute':
      return [];
    case 'github.investigation.account':
    case 'github.investigation.repositories':
    case 'github.investigation.read':
      return [];
    case 'knowledge.search':
    case 'knowledge.read':
    case 'knowledge.retrieve':
    case 'conversation.messages.read':
      return [];
    case 'web.fetch':
      return [{ kind: 'public-web', url: call.url }];
    case 'web.search':
      return publicWebResultSchema.parse(result).sources.map(source => ({ kind: 'public-web', url: source.url }));
    case 'tables.list':
      return z
        .object({ tables: z.array(z.object({ id: z.uuid(), savedRevision: z.string() })) })
        .parse(result)
        .tables.map(item => ({ kind: 'table-schema', tableId: item.id, revision: item.savedRevision }));
    case 'schema.inspect':
    case 'schema.status':
      return [
        {
          kind: 'table-schema',
          tableId: call.tableId,
          revision: z.object({ savedRevision: z.string() }).parse(result).savedRevision,
        },
      ];
    case 'schema.context': {
      const teams = z
        .object({ teams: ids })
        .parse(result)
        .teams.map(item => ({ kind: 'creation-team' as const, teamId: item.id, authority: 'table' as const }));
      if (!call.tableId) return teams;
      const revision = z
        .string()
        .parse(
          (
            await tx.client.query(`SELECT target_revision FROM ${relation(tx, 'tf_table_catalog')} WHERE id=$1`, [
              call.tableId,
            ])
          ).rows[0]?.target_revision,
        );
      return [...teams, { kind: 'table-schema', tableId: call.tableId, revision }];
    }
    case 'agents.context':
      return z
        .object({ teams: ids })
        .parse(result)
        .teams.map(item => ({ kind: 'creation-team', teamId: item.id, authority: 'agent' }));
    case 'agents.list':
      return z
        .object({ agents: z.array(z.object({ id: z.uuid(), savedRevision: z.string() })) })
        .parse(result)
        .agents.map(item => ({ kind: 'agent-definition', agentId: item.id, revision: item.savedRevision }));
    case 'agents.read':
      return [
        {
          kind: 'agent-definition',
          agentId: call.agentId,
          revision: z.object({ savedRevision: z.string() }).parse(result).savedRevision,
        },
      ];
    case 'workflows.read':
      return [
        {
          kind: 'workflow-definition',
          workflowId: call.workflowId,
          revision: z.object({ revision: z.uuid() }).parse(result).revision,
        },
      ];
    case 'workflows.providers':
      return z
        .object({ providers: z.array(z.object({ id: z.uuid(), generation: z.number().int().positive() })) })
        .parse(result)
        .providers.map(source => ({
          kind: 'workflow-provider',
          integrationId: source.id,
          generation: source.generation,
        }));
    case 'agents.task.start':
    case 'agents.task.read':
      return [
        {
          kind: 'private-task',
          taskId: call.tool === 'agents.task.start' ? z.object({ taskId: z.uuid() }).parse(result).taskId : call.taskId,
        },
      ];
    case 'skills.workspace':
      return z
        .object({ workspace: z.array(z.object({ id: z.uuid(), revision: z.string() })) })
        .parse(result)
        .workspace.map(item => ({ kind: 'workspace-skill', skillId: item.id, revision: item.revision }));
    case 'skills.workspace.read':
      return [
        {
          kind: 'workspace-skill',
          skillId: call.skillId,
          revision: z.object({ revision: z.string() }).parse(result).revision,
        },
      ];
    case 'skills.load':
    case 'skills.files.read':
    case 'skills.execute':
      return [{ kind: 'workspace-skill', skillId: call.skillId, revision: call.revision }];
    case 'skills.read':
      return z.uuid().safeParse(call.skillId).success
        ? [
            {
              kind: 'workspace-skill',
              skillId: call.skillId,
              revision: z.object({ revision: z.string().regex(/^[a-f0-9]{64}$/) }).parse(result).revision,
            },
          ]
        : [];
    case 'skills.import':
    case 'skills.import.status':
    case 'skills.import.select':
      return [];
    case 'atlassian.sources':
      return [];
    case 'atlassian.read':
    case 'atlassian.propose':
    case 'atlassian.proposal':
    case 'atlassian.execute':
    case 'google.read':
    case 'google.propose':
    case 'google.status':
    case 'google.execute':
    case 'slack.resolve':
    case 'slack.message.send':
    case 'slack.thread.reply':
    case 'slack.reaction.add':
    case 'tables.import.attachments':
    case 'tables.import.file':
    case 'files.create':
    case 'agents.status':
    case 'agents.draft':
    case 'skills.draft':
    case 'workflows.list':
    case 'workflows.draft':
    case 'skills.list':
      return [];
    case 'bud.preference.ask':
    case 'bud.preference.propose':
    case 'present.choice':
    case 'plans.create':
    case 'plans.read':
    case 'plans.update':
    case 'plans.claim':
    case 'plans.report':
    case 'plans.start':
    case 'agents.delegate':
      throw new AccessDenied();
    default: {
      const exhaustive: never = call;
      return exhaustive;
    }
  }
}
