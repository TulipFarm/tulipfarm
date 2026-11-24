import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browserNotOpened } from '../src/browser-receipts.ts';

const refused = (tool, error) => browserNotOpened({ tool, output: { result: { error, instruction: 'Try again.' } } });

test('a browser call refused before any browser opened is marked, including the host being full', () => {
  for (const error of ['browser-busy', 'capacity', 'out-of-credits', 'credit-allowance-used'])
    assert.deepEqual(refused('browser.act', error), { browserNotOpened: true }, error);
  assert.deepEqual(refused('browser.handoff', 'capacity'), { browserNotOpened: true });
});

test('errors that can follow an open browser, and other tools, are not marked', () => {
  for (const error of ['unavailable', 'person-in-control', 'action-failed', 'invalid-request', 'session-not-found'])
    assert.deepEqual(refused('browser.act', error), {}, error);
  assert.deepEqual(refused('web.search', 'capacity'), {});
  assert.deepEqual(browserNotOpened({ tool: 'browser.act', output: { result: { url: 'https://example.com' } } }), {});
});
