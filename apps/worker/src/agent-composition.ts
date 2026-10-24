import { createAgentExecutor } from '@tulipfarm/agents';
import { integrationCredentialKeyring, createIntegrationService } from '@tulipfarm/integrations';
import { googleOperations } from './google-composition.ts';
import { slackActionsFromEnvironment } from '@tulipfarm/agents/slack-environment';
import type { SkillExecutionFactory } from '@tulipfarm/agents/skill-execution';
import { runImageChoice } from '@tulipfarm/agents/image-generation';
import type { ImageOutputStore } from '@tulipfarm/conversations/image-outputs';

export function createAgentComposition(
  runtime: Parameters<typeof createAgentExecutor>[0]['runtime'],
  skills?: SkillExecutionFactory,
  files?: ImageOutputStore,
) {
  return createAgentExecutor({
    runtime,
    skills,
    integrations: createIntegrationService({ runtime, keyring: integrationCredentialKeyring() }),
    google: googleOperations,
    slack: slackActionsFromEnvironment(),
    ...(files ? { images: { files, choose: runImageChoice } } : {}),
  });
}
