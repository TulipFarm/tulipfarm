import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createServer } from 'vite';
import * as api from '@tulipfarm/secrets/contracts';
import type * as WebContracts from '../src/features/secrets/contracts.ts';

const server = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  optimizeDeps: { noDiscovery: true, include: [] },
});
after(() => server.close());
// The web app keeps its own copy, so the field suggests the same name the server would generate.
const web = (await server.ssrLoadModule('/src/features/secrets/contracts.ts')) as typeof WebContracts;

const names = [
  'Stripe',
  'stripe key',
  'GitHub token',
  'Café crème',
  '日本',
  '',
  '42 things',
  'x'.repeat(90),
  'a--b__c',
];

test('the web suggests the variable name the server generates', () => {
  for (const name of names)
    for (const kind of web.secretKinds)
      assert.equal(web.suggestVariableName(name, kind), api.suggestVariableName(name, kind), `${name} ${kind}`);
});

test('the web accepts exactly the variable names the server accepts', () => {
  for (const value of ['STRIPE_KEY', ' stripe_key ', 'A', '1KEY', 'BAD-NAME', '', 'A'.repeat(64), 'A'.repeat(65)])
    assert.equal(
      web.variableNameSchema.safeParse(value).success,
      api.variableNameSchema.safeParse(value).success,
      value,
    );
});

test('suggested names follow the kind and are always valid', () => {
  assert.equal(web.suggestVariableName('Stripe', 'api-key'), 'STRIPE_KEY');
  assert.equal(web.suggestVariableName('GitHub', 'token'), 'GITHUB_TOKEN');
  assert.equal(web.suggestVariableName('Stripe key', 'api-key'), 'STRIPE_KEY');
  for (const name of names)
    assert.ok(web.variableNameSchema.safeParse(web.suggestVariableName(name, 'api-key')).success);
});

test('the web fits placements to kinds exactly as the server does', () => {
  assert.deepEqual([...web.placementKinds].sort(), [...api.placementKinds].sort());
  const placements = [
    { kind: 'bearer' },
    { kind: 'basic' },
    { kind: 'browser' },
    { kind: 'header', name: 'x-api-key' },
    { kind: 'body', format: 'form', fields: ['user', 'pass'] },
    { kind: 'body', format: 'json', fields: ['token'] },
  ] as const;
  for (const kind of web.secretKinds)
    for (const placement of placements)
      assert.equal(web.placementFits(kind, placement), api.placementFits(kind, placement), `${kind} ${placement.kind}`);
});
