import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { SerializerSelector } from '@fastify/fast-json-stringify-compiler';
import { lazySerializers } from '../src/lazy-serializers.ts';

const response = {
  200: {
    type: 'object',
    properties: { id: { type: 'string' }, count: { type: 'integer' } },
  },
};

function countingFactory() {
  const build = SerializerSelector();
  const compiled = [];
  const factory = (externalSchemas, options) => {
    const compile = build(externalSchemas, options);
    return route => {
      compiled.push(`${route.method} ${route.url} ${route.httpStatus}`);
      return compile(route);
    };
  };
  return { factory, compiled };
}

test('response serializers compile on the first response, not before the server is ready', async () => {
  const { factory, compiled } = countingFactory();
  const app = Fastify({ schemaController: { compilersFactory: { buildSerializer: lazySerializers(factory) } } });
  app.get('/served', { schema: { response } }, async () => ({ id: 'a', count: 1 }));
  app.get('/unused', { schema: { response } }, async () => ({ id: 'b', count: 2 }));
  await app.ready();
  assert.deepEqual(compiled, []);

  await app.inject('/served');
  await app.inject('/served');
  assert.deepEqual(compiled, ['GET /served 200']);
  await app.close();
});

test('lazy serializers send what the default serializer sends', async () => {
  const handler = async () => ({ id: 'a', count: '7', secret: 'not in the schema' });
  const eager = Fastify();
  const lazy = Fastify({ schemaController: { compilersFactory: { buildSerializer: lazySerializers() } } });
  for (const app of [eager, lazy]) app.get('/item', { schema: { response } }, handler);

  const [expected, actual] = await Promise.all([eager.inject('/item'), lazy.inject('/item')]);
  assert.equal(actual.body, expected.body);
  assert.deepEqual(JSON.parse(actual.body), { id: 'a', count: 7 });
  await Promise.all([eager.close(), lazy.close()]);
});
