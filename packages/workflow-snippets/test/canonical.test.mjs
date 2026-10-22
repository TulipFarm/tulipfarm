import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonical } from '../src/canonical.ts';

test('command identity sorts nested object keys and preserves array order and JSON scalar bytes', () => {
  assert.equal(canonical({ z: [3, { b: false, a: null }], a: 'é\n' }), '{"a":"é\\n","z":[3,{"a":null,"b":false}]}');
  assert.equal(canonical({ a: 'é\n', z: [3, { a: null, b: false }] }), '{"a":"é\\n","z":[3,{"a":null,"b":false}]}');
  assert.equal(canonical([2, 1]), '[2,1]');
});
