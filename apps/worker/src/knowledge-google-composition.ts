import { createGoogleWorkspaceService } from '@tulipfarm/google-workspace';
import { createGoogleCorpusProvider } from '@tulipfarm/google-workspace/corpus';
import { createGoogleKnowledge } from '@tulipfarm/knowledge';
import type { KnowledgeSourceGate } from '@tulipfarm/knowledge';
import { createGoogleKnowledgeActivities } from './knowledge-google-activities.ts';

export function createWorkerGoogleKnowledge(dependencies: {
  runtime: Parameters<typeof createGoogleKnowledge>[0]['runtime'];
  gate?: KnowledgeSourceGate;
  googleService?: ReturnType<typeof createGoogleWorkspaceService>;
  providerFetch?: typeof fetch;
  recognition?: Parameters<typeof createGoogleKnowledge>[0]['recognition'];
  recognitionAvailable?: Parameters<typeof createGoogleKnowledge>[0]['recognitionAvailable'];
}) {
  return createGoogleKnowledge({
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
    ...(dependencies.gate ? { gate: dependencies.gate } : {}),
    ...(dependencies.recognition ? { recognition: dependencies.recognition } : {}),
    ...(dependencies.recognitionAvailable ? { recognitionAvailable: dependencies.recognitionAvailable } : {}),
  });
}

/** The Google sync service and the activities the knowledge worker runs for it. */
export function createGoogleKnowledgeParts(dependencies: Parameters<typeof createWorkerGoogleKnowledge>[0]) {
  const service = createWorkerGoogleKnowledge(dependencies);
  return { service, activities: createGoogleKnowledgeActivities(service) };
}
