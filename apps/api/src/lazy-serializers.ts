import { SerializerSelector } from '@fastify/fast-json-stringify-compiler';

type SerializerFactory = ReturnType<typeof SerializerSelector>;

/**
 * Fastify's default serializer factory, except each route's response serializer compiles on its first response.
 *
 * Fastify compiles every response schema in one synchronous step before the server listens. On a 0.25 vCPU share
 * that held the event loop for about 30 s, so a new task missed its health checks after each rollout, and the jobs
 * process, which only answers health checks, paid it for routes it never serves. The output is unchanged: the same
 * fast-json-stringify serializer still drops properties a schema doesn't declare.
 */
export function lazySerializers(build: SerializerFactory = SerializerSelector()): SerializerFactory {
  return (externalSchemas, options) => {
    const compile = build(externalSchemas, options);
    return route => {
      let serialize: ((doc: unknown) => string) | undefined;
      return doc => (serialize ??= compile(route))(doc);
    };
  };
}
