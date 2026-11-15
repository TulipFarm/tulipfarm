import { z } from 'zod';
import type { FastifyBaseLogger } from 'fastify';
import { createFiles, type FileBytes } from '@tulipfarm/files';
import type { chatObjectStore } from '@tulipfarm/workspaces/chat-objects';
import { attachmentLimit } from '@tulipfarm/conversations/attachments';
import { imageGenerationDetails } from '@tulipfarm/conversations/image-outputs';
import { isFeatureEnabled } from '@tulipfarm/observability';

const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const ownedKey = z.string().regex(new RegExp(`^${uuid}/files/${uuid}$`));
// Files also reads and removes the chat attachment objects that published files borrow, but writes only its own.
const objectKey = z.string().regex(new RegExp(`^${uuid}/(?:files/)?${uuid}$`));
const byteLength = z.number().int().min(1).max(attachmentLimit);

export function filesObjectAdapter(
  objects: Pick<NonNullable<ReturnType<typeof chatObjectStore>>, 'putIfAbsent' | 'read' | 'remove'>,
): FileBytes {
  return {
    async putIfAbsent(key, bytes, signal) {
      ownedKey.parse(key);
      byteLength.parse(bytes.byteLength);
      await objects.putIfAbsent(key, bytes, signal);
    },
    async read(key, maximumBytes, signal) {
      objectKey.parse(key);
      byteLength.parse(maximumBytes);
      return objects.read(key, maximumBytes, signal);
    },
    async remove(key) {
      objectKey.parse(key);
      await objects.remove(key);
    },
  };
}

export function createFilesService(
  log: FastifyBaseLogger,
  dependencies: {
    runtime: Parameters<typeof createFiles>[0];
    objects: Parameters<typeof filesObjectAdapter>[0];
    quotaBytes?: number | undefined;
  },
) {
  return createFiles(dependencies.runtime, filesObjectAdapter(dependencies.objects), {
    log,
    generation: async (tx, actor, workspaceId, fileId) =>
      (await isFeatureEnabled('images', null, { id: workspaceId }))
        ? imageGenerationDetails(tx, actor, fileId)
        : undefined,
    ...(dependencies.quotaBytes === undefined ? {} : { quotaBytes: dependencies.quotaBytes }),
  });
}
