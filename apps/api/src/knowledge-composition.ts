import type { FastifyInstance } from 'fastify';
import { createFiles } from '@tulipfarm/files';
import {
  createConversationKnowledge,
  createLocalKnowledge,
  KnowledgeError,
  type LocalKnowledgeOptions,
} from '@tulipfarm/knowledge';
import { parseKnowledgeEmbeddingsConfig } from '@tulipfarm/config';
import {
  createKnowledgeAgentTools,
  createKnowledgeEmbeddings,
  createKnowledgeSearch,
  createKnowledgeSourceFailures,
} from '@tulipfarm/knowledge';
import { createKnowledgeEmbeddingCapacity } from '@tulipfarm/knowledge/embedding-capacity';
import type { Pool } from 'pg';
import { registerKnowledge } from './knowledge.ts';
import { registerKnowledgeEmbeddingDispatch } from './knowledge-embedding-dispatch.ts';
import type { createTemporalClient } from './temporal.ts';
import { createGoogleWorkspaceService } from '@tulipfarm/google-workspace';
import { createGoogleCorpusProvider } from '@tulipfarm/google-workspace/corpus';
import { createGoogleKnowledge } from '@tulipfarm/knowledge';
import { AccessDenied, lockAuthorization, resolveHuman, uuidSchema } from '@tulipfarm/access';
import { qualified, commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { z } from 'zod';
import { googleDocumentsResponseSchema, googleMembersSchema, registerGoogleKnowledge } from './knowledge-google.ts';
import { registerGoogleKnowledgeDispatch } from './knowledge-google-dispatch.ts';
import { createSlackKnowledge, type SlackCorpusProvider } from '@tulipfarm/knowledge';
import { slackCorpusFromEnvironment } from '@tulipfarm/slack/corpus';
import { registerSlackKnowledge, slackDocumentsResponseSchema } from './knowledge-slack.ts';
import { registerSlackKnowledgeDispatch } from './knowledge-slack-dispatch.ts';
import { createGitHubKnowledge, type GitHubCorpusProvider } from '@tulipfarm/knowledge';
import { githubCorpusFromEnvironment } from '@tulipfarm/github/corpus';
import { registerGitHubKnowledge, githubDocumentsResponseSchema } from './knowledge-github.ts';
import { registerGitHubKnowledgeDispatch } from './knowledge-github-dispatch.ts';
import { githubKnowledgeEventsFromEnvironment, registerGitHubKnowledgeEvents } from './knowledge-github-events.ts';
import { registerGitHubDeliveryRetention } from './github-delivery-retention.ts';
import { createAtlassianKnowledge, type AtlassianCorpusProvider } from '@tulipfarm/knowledge';
import { atlassianCorpusFromEnvironment } from '@tulipfarm/atlassian/corpus';
import { atlassianDocumentsResponseSchema, registerAtlassianKnowledge } from './knowledge-atlassian.ts';
import { registerAtlassianKnowledgeDispatch } from './knowledge-atlassian-dispatch.ts';
import {
  createDefaultKnowledge,
  createDefaultKnowledgeGate,
  defaultKnowledgeFlagEnabled,
  type DefaultKnowledge,
} from '@tulipfarm/knowledge';
import { registerDefaultKnowledge } from './knowledge-defaults.ts';
import { registerDefaultKnowledgeDispatch, type defaultKnowledgeStarter } from './knowledge-defaults-dispatch.ts';

export function registerKnowledgeComposition(
  app: FastifyInstance,
  dependencies: {
    auth: Parameters<typeof registerKnowledge>[1]['auth'];
    runtime: LocalKnowledgeOptions['runtime'];
    files?: LocalKnowledgeOptions['files'];
    pool?: Pool;
    temporal?: ReturnType<typeof createTemporalClient>;
    env?: NodeJS.ProcessEnv;
    provider?: Parameters<typeof createKnowledgeEmbeddings>[0]['provider'];
    googleService?: ReturnType<typeof createGoogleWorkspaceService>;
    providerFetch?: typeof fetch;
    slackCorpus?: SlackCorpusProvider;
    githubCorpus?: GitHubCorpusProvider;
    atlassianCorpus?: AtlassianCorpusProvider;
    defaultKnowledge?: ReturnType<typeof defaultKnowledgeStarter>;
  },
) {
  const gate = createDefaultKnowledgeGate({ runtime: dependencies.runtime });
  const unavailable = async (): Promise<never> => {
    throw new KnowledgeError('adapter-required');
  };
  const files =
    dependencies.files ??
    createFiles(dependencies.runtime, { read: unavailable, putIfAbsent: unavailable, remove: unavailable });
  const service = createLocalKnowledge({ runtime: dependencies.runtime, files });
  const conversations = createConversationKnowledge({ runtime: dependencies.runtime });
  const google = createGoogleKnowledge({
    runtime: dependencies.runtime,
    provider: createGoogleCorpusProvider({
      service:
        dependencies.googleService ??
        createGoogleWorkspaceService({
          runtime: dependencies.runtime,
          ...(dependencies.providerFetch ? { providerFetch: dependencies.providerFetch } : {}),
        }),
      ...(dependencies.providerFetch ? { providerFetch: dependencies.providerFetch } : {}),
    }),
    gate,
  });
  const slack = createSlackKnowledge({
    runtime: dependencies.runtime,
    provider:
      dependencies.slackCorpus ??
      slackCorpusFromEnvironment({
        runtime: dependencies.runtime,
        ...(dependencies.env ? { env: dependencies.env } : {}),
      }),
    gate,
  });
  const github = createGitHubKnowledge({
    runtime: dependencies.runtime,
    provider:
      dependencies.githubCorpus ??
      githubCorpusFromEnvironment({
        runtime: dependencies.runtime,
        ...(dependencies.env ? { env: dependencies.env } : {}),
      }),
    gate,
  });
  const atlassian = createAtlassianKnowledge({
    runtime: dependencies.runtime,
    provider:
      dependencies.atlassianCorpus ??
      atlassianCorpusFromEnvironment({
        runtime: dependencies.runtime,
        ...(dependencies.env ? { env: dependencies.env } : {}),
      }),
    gate,
  });
  const defaults: DefaultKnowledge = createDefaultKnowledge({
    runtime: dependencies.runtime,
    engines: { google, slack, github, atlassian },
  });
  dependencies.defaultKnowledge?.attach(defaults);
  async function documentAdapter(workspaceId: string, userId: string, documentId: string) {
    const provider = await dependencies.runtime.transaction(
      uuidSchema.parse(workspaceId),
      commonCompatibility,
      async tx => {
        await lockAuthorization(tx);
        await resolveHuman(tx, userId);
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
      await lockAuthorization(tx);
      await resolveHuman(tx, userId);
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
  const config = parseKnowledgeEmbeddingsConfig(dependencies.env ?? process.env);
  if (config.kind === 'enabled' && !dependencies.pool)
    throw new Error('Knowledge embeddings require the application registry pool');
  const embeddings = createKnowledgeEmbeddings({
    runtime: dependencies.runtime,
    config,
    google,
    slack,
    github,
    atlassian,
    gate,
    ...(config.kind === 'enabled' && dependencies.pool
      ? {
          ...(dependencies.provider ? { provider: dependencies.provider } : {}),
          capacity: createKnowledgeEmbeddingCapacity(dependencies.pool).acquire,
        }
      : {}),
  });
  const search = createKnowledgeSearch({ runtime: dependencies.runtime, embeddings, google, slack, github, atlassian });
  registerKnowledge(app, {
    auth: dependencies.auth,
    service,
    embeddings,
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
        await lockAuthorization(tx);
        const actor = await resolveHuman(tx, userId);
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
        await lockAuthorization(tx);
        const actor = await resolveHuman(tx, userId);
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
        await lockAuthorization(tx);
        const actor = await resolveHuman(tx, userId);
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
        await lockAuthorization(tx);
        const actor = await resolveHuman(tx, userId);
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
  const githubEvents = githubKnowledgeEventsFromEnvironment(dependencies.pool, dependencies.env ?? process.env);
  registerGitHubKnowledgeEvents(app, githubEvents);
  if (dependencies.pool) registerGitHubDeliveryRetention(app, dependencies.pool, dependencies.env ?? process.env);
  registerDefaultKnowledge(app, {
    auth: dependencies.auth,
    service: defaults,
    enabled: defaultKnowledgeFlagEnabled,
    ...(dependencies.defaultKnowledge ? { started: dependencies.defaultKnowledge.hook.started } : {}),
  });
  if (dependencies.pool && dependencies.temporal) {
    registerDefaultKnowledgeDispatch(app, {
      pool: dependencies.pool,
      temporal: dependencies.temporal,
      service: defaults,
    });
    registerKnowledgeEmbeddingDispatch(app, {
      pool: dependencies.pool,
      temporal: dependencies.temporal,
      service: embeddings,
    });
    registerGoogleKnowledgeDispatch(app, { pool: dependencies.pool, temporal: dependencies.temporal, service: google });
    registerSlackKnowledgeDispatch(app, { pool: dependencies.pool, temporal: dependencies.temporal, service: slack });
    registerGitHubKnowledgeDispatch(app, {
      pool: dependencies.pool,
      temporal: dependencies.temporal,
      service: github,
      events: githubEvents,
    });
    registerAtlassianKnowledgeDispatch(app, {
      pool: dependencies.pool,
      temporal: dependencies.temporal,
      service: atlassian,
    });
  }
  return service;
}
