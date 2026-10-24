import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { createFiles, type FileBytes } from '@tulipfarm/files';
import type { chatObjectStore } from '@tulipfarm/workspaces/chat-objects';
import { attachmentLimit } from '@tulipfarm/conversations/attachments';
import { imageGenerationDetails } from '@tulipfarm/conversations/image-outputs';
import { isFeatureEnabled } from '@tulipfarm/observability';
import { registerFiles } from './files.ts';

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

export function registerFilesComposition(
  app: FastifyInstance,
  dependencies: {
    auth: Parameters<typeof registerFiles>[1]['auth'];
    runtime: Parameters<typeof createFiles>[0];
    objects: Parameters<typeof filesObjectAdapter>[0];
    identity: Parameters<typeof registerFiles>[1]['identity'];
    quotaBytes?: number;
  },
) {
  const service = createFiles(dependencies.runtime, filesObjectAdapter(dependencies.objects), {
    log: app.log,
    generation: async (tx, actor, workspaceId, fileId) =>
      (await isFeatureEnabled('images', null, { id: workspaceId }))
        ? imageGenerationDetails(tx, actor, fileId)
        : undefined,
    ...(dependencies.quotaBytes === undefined ? {} : { quotaBytes: dependencies.quotaBytes }),
  });
  registerFiles(app, { auth: dependencies.auth, service, identity: dependencies.identity });
  return service;
}
