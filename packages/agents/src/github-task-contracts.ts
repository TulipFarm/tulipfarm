import { z } from 'zod';
import { sourceDependenciesSchema } from '@tulipfarm/access/source-dependencies';
import { githubReadSchema, githubDownloadSchema } from '@tulipfarm/github/read-contracts';
import { githubBatchInputSchema } from '@tulipfarm/github/batch-contracts';
import { investigationCallOptions } from '@tulipfarm/github/investigation-contracts';

export const githubTaskCallSchema = z.discriminatedUnion('tool', [
  ...investigationCallOptions,
  z.strictObject({ tool: z.literal('github.personal.account') }),
  z.strictObject({ tool: z.literal('github.personal.read'), operation: githubReadSchema }),
  z.strictObject({ tool: z.literal('github.personal.download'), operation: githubDownloadSchema }),
  z.strictObject({ tool: z.literal('github.personal.propose'), ...githubBatchInputSchema.shape }),
]);
export const githubTaskResultSchema = z.strictObject({
  provider: z.enum(['github-personal', 'github-investigation']),
  state: z.enum(['completed', 'waiting-approval', 'selection-required', 'tool-limit', 'unresolved', 'failed']),
  data: z.json(),
  sources: sourceDependenciesSchema,
});
export const isGitHubTaskCall = (call: { tool: string }): call is z.infer<typeof githubTaskCallSchema> =>
  githubTaskCallSchema.options.some(option => option.shape.tool.value === call.tool);
