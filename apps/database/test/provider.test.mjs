import assert from 'node:assert/strict';
import { test } from 'node:test';
import { databaseProvider } from '../src/config.ts';
import { azureManagement } from '../src/azure.ts';
import { loginConnectionUrl } from '../src/postgres.ts';

test('Postgres is the default and Azure management requires explicit selection', () => {
  assert.equal(databaseProvider({}), 'postgres');
  assert.equal(databaseProvider({ DATABASE_PROVIDER: '' }), 'postgres');
  assert.equal(databaseProvider({ DATABASE_PROVIDER: 'azure' }), 'azure');
  assert.throws(() => databaseProvider({ DATABASE_PROVIDER: 'unknown' }), /DATABASE_PROVIDER/);
  const previous = process.env.DATABASE_PROVIDER;
  try {
    delete process.env.DATABASE_PROVIDER;
    assert.throws(() => azureManagement(), /Select DATABASE_PROVIDER=azure/);
  } finally {
    if (previous === undefined) delete process.env.DATABASE_PROVIDER;
    else process.env.DATABASE_PROVIDER = previous;
  }
});

test('scoped Postgres URLs preserve the admin host, custom port, TLS and other query parameters', () => {
  const admin =
    'postgresql://admin:master@postgres.example.com:5544/postgres?sslmode=verify-full&application_name=setup';
  const scoped = new URL(loginConnectionUrl(admin, 'tulipfarm', 'tulipfarm_owner', 'test/@password'));
  assert.equal(scoped.host, 'postgres.example.com:5544');
  assert.equal(scoped.pathname, '/tulipfarm');
  assert.equal(scoped.username, 'tulipfarm_owner');
  assert.equal(decodeURIComponent(scoped.password), 'test/@password');
  assert.equal(scoped.search, new URL(admin).search);
  assert.throws(() => loginConnectionUrl('https://example.com', 'tulipfarm', 'owner', 'password'), /PostgreSQL/);
});
