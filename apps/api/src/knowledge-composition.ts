import type { FastifyInstance } from 'fastify';
import { createKnowledgeAgentTools, createKnowledgeSourceFailures, KnowledgeError } from '@tulipfarm/knowledge';
import { AccessDenied, lockAndResolveHuman, uuidSchema } from '@tulipfarm/access';
import { qualified, commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { z } from 'zod';
import { registerKnowledge } from './knowledge.ts';
import type { createTemporalClient } from './temporal.ts';
import { googleDocumentsResponseSchema, googleMembersSchema, registerGoogleKnowledge } from './knowledge-google.ts';
import { registerSlackKnowledge, slackDocumentsResponseSchema } from './knowledge-slack.ts';
import { registerGitHubKnowledge, githubDocumentsResponseSchema } from './knowledge-github.ts';
import { registerGitHubKnowledgeEvents, type GitHubWorkflowFanOut } from './knowledge-github-events.ts';
import { registerGitHubDeliveryRetention } from './github-delivery-retention.ts';
import { atlassianDocumentsResponseSchema, registerAtlassianKnowledge } from './knowledge-atlassian.ts';
import { registerDefaultKnowledge } from './knowledge-defaults.ts';
import {
  createKnowledgeServices,
  registerKnowledgeSweeps,
  type KnowledgeServiceDependencies,
  type KnowledgeServices,
} from './knowledge-services.ts';

export function registerKnowledgeComposition(
  app: FastifyInstance,
  dependencies: KnowledgeServiceDependencies & {
    auth: Parameters<typeof registerKnowledge>[1]['auth'];
    temporal?: ReturnType<typeof createTemporalClient>;
    githubWorkflowFanOut?: GitHubWorkflowFanOut;
  },
) {
  const services = createKnowledgeServices(dependencies);
  registerKnowledgeRoutes(app, dependencies, services);
  if (dependencies.pool && dependencies.temporal)
    registerKnowledgeSweeps(app, { pool: dependencies.pool, temporal: dependencies.temporal }, services);
  return services.service;
}

export function registerKnowledgeRoutes(
  app: FastifyInstance,
  dependencies: Pick<KnowledgeServiceDependencies, 'runtime' | 'pool' | 'env' | 'defaultKnowledge'> & {
    auth: Parameters<typeof registerKnowledge>[1]['auth'];
    githubWorkflowFanOut?: GitHubWorkflowFanOut;
  },
  services: KnowledgeServices,
) {
  const { service, conversations, google, slack, github, atlassian, defaults, search } = services;
  async function documentAdapter(workspaceId: string, userId: string, documentId: string) {
    const provider = await dependencies.runtime.transaction(
      uuidSchema.parse(workspaceId),
      commonCompatibility,
      async tx => {
        await lockAndResolveHuman(tx, userId);
        const row = z
          .object({
            provider: z.enum(['note', 'file', 'google', 'slack', 'github', 'confluence', 'jira', 'conversation']),
          })
          .optional()
          .parse(
            (
              await tx.client.query(
                `SELECT s.provider FROM ${qualified(tx.schema, 'tf_knowledge_documents')} d JOIN ${qualified(tx.schema, 'tf_knowledge_sources')} s ON s.id=d.source_id WHERE d.id=$1`,
                [uuidSchema.parse(documentId)],
              )
            ).rows[0],
          );
        if (!row) throw new AccessDenied();
        return row.provider;
      },
    );
    return provider === 'conversation'
      ? conversations
      : provider === 'google'
        ? google
        : provider === 'slack'
          ? slack
          : provider === 'github'
            ? github
            : provider === 'confluence' || provider === 'jira'
              ? atlassian
              : service;
  }
  const members = (workspaceId: string, userId: string) =>
    dependencies.runtime.transaction(uuidSchema.parse(workspaceId), commonCompatibility, async tx => {
      await lockAndResolveHuman(tx, userId);
      if (!dependencies.pool) throw new KnowledgeError('adapter-required');
      const members = z
        .array(z.object({ id: z.uuid(), user_id: z.string() }))
        .parse(
          (
            await tx.client.query(
              `SELECT id,user_id FROM ${qualified(tx.schema, 'tf_memberships')} WHERE removed_at IS NULL ORDER BY created_at,id`,
            )
          ).rows,
        );
      const profiles = z
        .array(z.object({ id: z.string(), name: z.string(), email: z.email() }))
        .parse(
          (
            await dependencies.pool.query('SELECT id,name,email FROM app.users WHERE id=ANY($1::uuid[])', [
              members.map(member => member.user_id),
            ])
          ).rows,
        );
      const byId = new Map(profiles.map(profile => [profile.id, profile]));
      return googleMembersSchema.parse({
        members: members.map(member => {
          const profile = byId.get(member.user_id);
          if (!profile) throw new KnowledgeError('incomplete');
          return { id: member.id, name: profile.name, email: profile.email };
        }),
      });
    });
  registerKnowledge(app, {
    auth: dependencies.auth,
    service,
    search,
    documentAdapter,
    citations: createKnowledgeAgentTools({ runtime: dependencies.runtime, search }),
    sourceFailures: createKnowledgeSourceFailures({ runtime: dependencies.runtime }),
  });
  registerGoogleKnowledge(app, {
    auth: dependencies.auth,
    service: google,
    documents: async (workspaceId, userId, sourceId, cursor) => {
      const result = await google.listDocuments(workspaceId, userId, sourceId, cursor);
      return dependencies.runtime.transaction(uuidSchema.parse(workspaceId), commonCompatibility, async tx => {
        const actor = await lockAndResolveHuman(tx, userId);
        const proofs = z
          .array(z.object({ document_id: z.uuid(), revision_id: z.uuid(), expires_at: z.date() }))
          .parse(
            (
              await tx.client.query(
                `SELECT e.document_id,d.observed_revision_id AS revision_id,e.expires_at FROM ${qualified(tx.schema, 'tf_knowledge_google_eligible')} e JOIN ${qualified(tx.schema, 'tf_knowledge_documents')} d ON d.id=e.document_id WHERE e.membership_id=$1 AND e.user_id=$2 AND e.document_id=ANY($3::uuid[])`,
                [actor.membershipId, actor.userId, result.items.map(item => item.documentId)],
              )
            ).rows,
          );
        const expiry = new Map(
          proofs.map(proof => [`${proof.document_id}:${proof.revision_id}`, proof.expires_at.toISOString()]),
        );
        return googleDocumentsResponseSchema.parse({
          ...result,
          items: result.items.flatMap(item => {
            const validUntil = expiry.get(`${item.documentId}:${item.revisionId}`);
            return validUntil ? [{ ...item, validUntil }] : [];
          }),
        });
      });
    },
    members,
  });
  registerSlackKnowledge(app, {
    auth: dependencies.auth,
    service: slack,
    members,
    documents: async (workspaceId, userId, sourceId, cursor) => {
      const result = await slack.listDocuments(workspaceId, userId, sourceId, cursor);
      return dependencies.runtime.transaction(uuidSchema.parse(workspaceId), commonCompatibility, async tx => {
        const actor = await lockAndResolveHuman(tx, userId);
        const proofs = z
          .array(z.object({ document_id: z.uuid(), revision_id: z.uuid(), expires_at: z.date() }))
          .parse(
            (
              await tx.client.query(
                `SELECT e.document_id,d.observed_revision_id AS revision_id,e.expires_at FROM ${qualified(tx.schema, 'tf_knowledge_slack_eligible')} e JOIN ${qualified(tx.schema, 'tf_knowledge_documents')} d ON d.id=e.document_id WHERE e.membership_id=$1 AND e.user_id=$2 AND e.document_id=ANY($3::uuid[])`,
                [actor.membershipId, actor.userId, result.items.map(item => item.documentId)],
              )
            ).rows,
          );
        const expiry = new Map(
          proofs.map(proof => [`${proof.document_id}:${proof.revision_id}`, proof.expires_at.toISOString()]),
        );
        return slackDocumentsResponseSchema.parse({
          ...result,
          items: result.items.flatMap(item => {
            const validUntil = expiry.get(`${item.documentId}:${item.revisionId}`);
            return validUntil ? [{ ...item, validUntil }] : [];
          }),
        });
      });
    },
  });
  registerGitHubKnowledge(app, {
    auth: dependencies.auth,
    service: github,
    members,
    documents: async (workspaceId, userId, sourceId, cursor) => {
      const result = await github.listDocuments(workspaceId, userId, sourceId, cursor);
      return dependencies.runtime.transaction(uuidSchema.parse(workspaceId), commonCompatibility, async tx => {
        const actor = await lockAndResolveHuman(tx, userId);
        const proofs = z
          .array(z.object({ document_id: z.uuid(), revision_id: z.uuid(), expires_at: z.date() }))
          .parse(
            (
              await tx.client.query(
                `SELECT e.document_id,d.observed_revision_id AS revision_id,e.expires_at FROM ${qualified(tx.schema, 'tf_knowledge_github_eligible')} e JOIN ${qualified(tx.schema, 'tf_knowledge_documents')} d ON d.id=e.document_id WHERE e.membership_id=$1 AND e.user_id=$2 AND e.document_id=ANY($3::uuid[])`,
                [actor.membershipId, actor.userId, result.items.map(item => item.documentId)],
              )
            ).rows,
          );
        const expiry = new Map(
          proofs.map(proof => [`${proof.document_id}:${proof.revision_id}`, proof.expires_at.toISOString()]),
        );
        return githubDocumentsResponseSchema.parse({
          ...result,
          items: result.items.flatMap(item => {
            const validUntil = expiry.get(`${item.documentId}:${item.revisionId}`);
            return validUntil ? [{ ...item, validUntil }] : [];
          }),
        });
      });
    },
  });
  registerAtlassianKnowledge(app, {
    auth: dependencies.auth,
    service: atlassian,
    members,
    documents: async (workspaceId, userId, sourceId, cursor) => {
      const result = await atlassian.listDocuments(workspaceId, userId, sourceId, cursor);
      return dependencies.runtime.transaction(uuidSchema.parse(workspaceId), commonCompatibility, async tx => {
        const actor = await lockAndResolveHuman(tx, userId);
        const proofs = z
          .array(z.object({ document_id: z.uuid(), revision_id: z.uuid(), expires_at: z.date() }))
          .parse(
            (
              await tx.client.query(
                `SELECT e.document_id,d.observed_revision_id AS revision_id,e.expires_at FROM ${qualified(tx.schema, 'tf_knowledge_atlassian_eligible')} e JOIN ${qualified(tx.schema, 'tf_knowledge_documents')} d ON d.id=e.document_id WHERE e.membership_id=$1 AND e.user_id=$2 AND e.document_id=ANY($3::uuid[])`,
                [actor.membershipId, actor.userId, result.items.map(item => item.documentId)],
              )
            ).rows,
          );
        const expiry = new Map(
          proofs.map(proof => [`${proof.document_id}:${proof.revision_id}`, proof.expires_at.toISOString()]),
        );
        return atlassianDocumentsResponseSchema.parse({
          ...result,
          items: result.items.flatMap(item => {
            const validUntil = expiry.get(`${item.documentId}:${item.revisionId}`);
            return validUntil ? [{ ...item, validUntil }] : [];
          }),
        });
      });
    },
  });
  registerGitHubKnowledgeEvents(app, services.githubEvents, dependencies.githubWorkflowFanOut);
  if (dependencies.pool) registerGitHubDeliveryRetention(app, dependencies.pool, dependencies.env ?? process.env);
  registerDefaultKnowledge(app, {
    auth: dependencies.auth,
    service: defaults,
    ...(dependencies.defaultKnowledge ? { started: dependencies.defaultKnowledge.hook.started } : {}),
  });
}
