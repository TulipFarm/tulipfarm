import { ApplicationFailure } from '@temporalio/common';
import { createFiles, type FileBytes } from '@tulipfarm/files';
import {
  createLocalKnowledge,
  knowledgeWorkSchema,
  KnowledgeError,
  type LocalKnowledgeOptions,
  type KnowledgeWork,
} from '@tulipfarm/knowledge';

export function createKnowledgeActivities(runtime: LocalKnowledgeOptions['runtime'], objects?: FileBytes) {
  const unavailable = async (): Promise<never> => {
    throw new KnowledgeError('adapter-required');
  };
  const service = createLocalKnowledge({
    runtime,
    files: createFiles(runtime, objects ?? { read: unavailable, putIfAbsent: unavailable, remove: unavailable }),
  });
  return {
    async processKnowledge(value: KnowledgeWork): Promise<void> {
      const parsed = knowledgeWorkSchema.safeParse(value);
      if (!parsed.success) throw ApplicationFailure.nonRetryable('Invalid knowledge work', 'InvalidKnowledgeWork');
      try {
        await service.process(parsed.data);
      } catch {
        throw ApplicationFailure.nonRetryable('Knowledge processing unavailable', 'KnowledgeUnavailable');
      }
    },
  };
}
