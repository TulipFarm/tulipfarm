import { LogController, type FastifyServerOptions } from 'fastify';
import { lazySerializers } from './lazy-serializers.ts';
import { securityServerOptions } from './security.ts';

/** Server options shared by the full API and the jobs process. */
export function apiServerOptions(): FastifyServerOptions {
  return {
    ...securityServerOptions(),
    logger: {
      serializers: {
        err: () => ({ type: 'Error', message: 'request_failed', stack: '' }),
        req: () => ({}),
        res: () => ({}),
      },
    },
    logController: new LogController({ disableRequestLogging: true }),
    schemaController: { compilersFactory: { buildSerializer: lazySerializers() } },
  };
}
