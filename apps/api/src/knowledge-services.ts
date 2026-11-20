import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { createFiles } from '@tulipfarm/files';
import {
  createAtlassianKnowledge,
  createConversationKnowledge,
  createDefaultKnowledge,
  createDefaultKnowledgeGate,
  createGitHubKnowledge,
  createGoogleKnowledge,
  createKnowledgeEmbeddings,
  createKnowledgeKeepFeed,
  createKnowledgeSearch,
  createLocalKnowledge,
  createSlackKnowledge,
  KnowledgeError,
  type AtlassianCorpusProvider,
  type DefaultKnowledge,
  type GitHubCorpusProvider,
  type LocalKnowledgeOptions,
  type SlackCorpusProvider,
} from '@tulipfarm/knowledge';
import { parseKnowledgeEmbeddingsConfig } from '@tulipfarm/config';
import { createKnowledgeEmbeddingCapacity } from '@tulipfarm/knowledge/embedding-capacity';
import { createGoogleWorkspaceService } from '@tulipfarm/google-workspace';
import { createGoogleCorpusProvider } from '@tulipfarm/google-workspace/corpus';
import { slackCorpusFromEnvironment } from '@tulipfarm/slack/corpus';
import { githubCorpusFromEnvironment } from '@tulipfarm/github/corpus';
import { atlassianCorpusFromEnvironment } from '@tulipfarm/atlassian/corpus';
import type { createTemporalClient } from './temporal.ts';
import { githubKnowledgeEventsFromEnvironment } from './knowledge-github-events.ts';
import { registerKnowledgeEmbeddingDispatch } from './knowledge-embedding-dispatch.ts';
import { registerKnowledgeKeepDispatch } from './knowledge-keep-dispatch.ts';
import { registerGoogleKnowledgeDispatch } from './knowledge-google-dispatch.ts';
import { registerSlackKnowledgeDispatch } from './knowledge-slack-dispatch.ts';
import { registerGitHubKnowledgeDispatch } from './knowledge-github-dispatch.ts';
import { registerAtlassianKnowledgeDispatch } from './knowledge-atlassian-dispatch.ts';
import { registerDefaultKnowledgeDispatch, type defaultKnowledgeStarter } from './knowledge-defaults-dispatch.ts';

export type KnowledgeServiceDependencies = {
  runtime: LocalKnowledgeOptions['runtime'];
  files?: LocalKnowledgeOptions['files'];
  pool?: Pool;
  env?: NodeJS.ProcessEnv;
  provider?: Parameters<typeof createKnowledgeEmbeddings>[0]['provider'];
  /** Whether document-vision recognition could run for a workspace now; lets dispatch re-parse unread images. */
  recognitionAvailable?: LocalKnowledgeOptions['recognitionAvailable'];
  googleService?: ReturnType<typeof createGoogleWorkspaceService>;
  providerFetch?: typeof fetch;
  slackCorpus?: SlackCorpusProvider;
  githubCorpus?: GitHubCorpusProvider;
  atlassianCorpus?: AtlassianCorpusProvider;
  defaultKnowledge?: ReturnType<typeof defaultKnowledgeStarter>;
};

export type KnowledgeServices = ReturnType<typeof createKnowledgeServices>;

/** The Knowledge services that both the routes and the background sweeps use. */
export function createKnowledgeServices(dependencies: KnowledgeServiceDependencies) {
  const gate = createDefaultKnowledgeGate({ runtime: dependencies.runtime });
  const unavailable = async (): Promise<never> => {
    throw new KnowledgeError('adapter-required');
  };
  const files =
    dependencies.files ??
    createFiles(dependencies.runtime, { read: unavailable, putIfAbsent: unavailable, remove: unavailable });
  const service = createLocalKnowledge({
    runtime: dependencies.runtime,
    files,
    ...(dependencies.recognitionAvailable ? { recognitionAvailable: dependencies.recognitionAvailable } : {}),
  });
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
  const githubEvents = githubKnowledgeEventsFromEnvironment(dependencies.pool, dependencies.env ?? process.env);
  const keep = createKnowledgeKeepFeed({ runtime: dependencies.runtime });
  return {
    gate,
    service,
    conversations,
    google,
    slack,
    github,
    atlassian,
    defaults,
    embeddings,
    search,
    githubEvents,
    keep,
  };
}

export function registerKnowledgeSweeps(
  app: FastifyInstance,
  dependencies: { pool: Pool; temporal: ReturnType<typeof createTemporalClient> },
  services: KnowledgeServices,
) {
  const { pool, temporal } = dependencies;
  registerDefaultKnowledgeDispatch(app, { pool, temporal, service: services.defaults });
  registerKnowledgeEmbeddingDispatch(app, { pool, temporal, service: services.embeddings });
  registerKnowledgeKeepDispatch(app, { pool, temporal, feed: services.keep });
  registerGoogleKnowledgeDispatch(app, { pool, temporal, service: services.google });
  registerSlackKnowledgeDispatch(app, { pool, temporal, service: services.slack });
  registerGitHubKnowledgeDispatch(app, { pool, temporal, service: services.github, events: services.githubEvents });
  registerAtlassianKnowledgeDispatch(app, { pool, temporal, service: services.atlassian });
}
