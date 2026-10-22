import assert from 'node:assert/strict';
import { test } from 'node:test';
import { devSessionsAllowed, safeRedirectPath } from '../src/dev-session.ts';

test('dev sessions stay local and without real email', () => {
  assert.equal(devSessionsAllowed({ NODE_ENV: 'development', HOST: '127.0.0.1' }), true);
  assert.equal(devSessionsAllowed({ NODE_ENV: 'production', HOST: '127.0.0.1' }), false);
  assert.equal(devSessionsAllowed({ NODE_ENV: 'development', HOST: '0.0.0.0' }), false);
  assert.equal(
    devSessionsAllowed({ NODE_ENV: 'development', ACS_CONNECTION_STRING: 'endpoint=https://acs.test/' }),
    false,
  );
  assert.equal(devSessionsAllowed({ NODE_ENV: 'development', SMTP_HOST: 'smtp.example.test' }), false);
  assert.equal(devSessionsAllowed({ NODE_ENV: 'development', EMAIL_PROVIDER: 'smtp' }), false);
});

test('dev session redirects stay on the web origin', () => {
  assert.equal(safeRedirectPath('/seed-rich/tables?x=1#a'), '/seed-rich/tables?x=1#a');
  for (const value of [undefined, 'https://evil.test', '//evil.test', '/\\evil.test', 'seed-rich'])
    assert.equal(safeRedirectPath(value), '/');
});
