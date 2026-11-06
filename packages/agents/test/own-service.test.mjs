import assert from 'node:assert/strict';
import test from 'node:test';
import { isOwnServiceUrl, ownServiceDomains } from '../dist/own-service.js';

test('the deployment’s own site and its parent domain are refused, other hosts are not', () => {
  const domains = ownServiceDomains(['https://app.tulipfarm.ai', 'https://api.tulipfarm.ai', undefined]);
  assert.ok(isOwnServiceUrl('https://tulipfarm.ai/api/tables/propose', domains));
  assert.ok(isOwnServiceUrl('https://API.tulipfarm.ai/v1/tables', domains));
  assert.ok(!isOwnServiceUrl('https://nottulipfarm.ai/x', domains));
  assert.ok(!isOwnServiceUrl('https://api.github.com/repos', domains));
  assert.deepEqual(ownServiceDomains(['http://127.0.0.1:5173']), ['127.0.0.1']);
  assert.deepEqual(ownServiceDomains([]), []);
});
