import type { FastifyInstance } from 'fastify';
import type { createFiles } from '@tulipfarm/files';
import { registerFiles } from './files.ts';
import { createFilesService, type filesObjectAdapter } from './files-service.ts';

export { filesObjectAdapter } from './files-service.ts';

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
  const service = createFilesService(app.log, dependencies);
  registerFiles(app, { auth: dependencies.auth, service, identity: dependencies.identity });
  return service;
}
