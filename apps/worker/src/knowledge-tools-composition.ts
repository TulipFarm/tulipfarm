import {
  createKnowledgeAgentTools,
  createKnowledgeKeepIndex,
  createKnowledgeSearch,
  type KnowledgeKeepDependencies,
} from '@tulipfarm/knowledge';
import type { KnowledgeToolsFactory } from '@tulipfarm/agents/tools';
import { createWorkerGoogleKnowledge } from './knowledge-google-composition.ts';
import { createWorkerSlackKnowledge } from './knowledge-slack-composition.ts';
import { createWorkerGitHubKnowledge } from './knowledge-github-composition.ts';
import { createWorkerAtlassianKnowledge } from './knowledge-atlassian-composition.ts';

type SearchOptions = Parameters<typeof createKnowledgeSearch>[0];

// Chat and task knowledge tools. Each call receives the caller's guarded runtime for search and evidence reads.
export function createKnowledgeTools(dependencies: {
  runtime: SearchOptions['runtime'];
  env?: NodeJS.ProcessEnv;
  /** Overrides the Keep client that search uses; defaults to the configured endpoint. */
  keepClient?: KnowledgeKeepDependencies['client'];
}): KnowledgeToolsFactory {
  const env = dependencies.env ?? process.env;
  const adapters = {
    google: createWorkerGoogleKnowledge({ runtime: dependencies.runtime }),
    slack: createWorkerSlackKnowledge({ runtime: dependencies.runtime, env }),
    github: createWorkerGitHubKnowledge({ runtime: dependencies.runtime, env }),
    atlassian: createWorkerAtlassianKnowledge({ runtime: dependencies.runtime, env }),
  };
  const index = createKnowledgeKeepIndex(dependencies.keepClient ? { client: dependencies.keepClient } : {});
  return runtime =>
    createKnowledgeAgentTools({ runtime, search: createKnowledgeSearch({ runtime, ...adapters, index }) });
}
