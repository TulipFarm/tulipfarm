import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { temporalConnectionOptions } from '../dist/temporal.js';
import { publicWebConfiguration } from '../dist/public-web.js';
import { secretSettingNames } from '../dist/settings.js';

test('Temporal preserves local defaults and accepts explicit TLS and API-key options', () => {
  assert.deepEqual(temporalConnectionOptions({}), {
    address: '127.0.0.1:7233',
  });
  assert.deepEqual(
    temporalConnectionOptions({
      TEMPORAL_ADDRESS: 'local:7233',
      TEMPORAL_TLS: '',
    }),
    {
      address: 'local:7233',
    },
  );
  assert.deepEqual(temporalConnectionOptions({ TEMPORAL_TLS: 'false' }), {
    address: '127.0.0.1:7233',
    tls: false,
  });
  assert.deepEqual(
    temporalConnectionOptions({
      TEMPORAL_ADDRESS: 'cloud.example.com:7233',
      TEMPORAL_TLS: 'true',
      TEMPORAL_API_KEY: 'test-key',
    }),
    { address: 'cloud.example.com:7233', tls: true, apiKey: 'test-key' },
  );
  assert.throws(() => temporalConnectionOptions({ TEMPORAL_TLS: 'yes' }), /TEMPORAL_TLS/);
});

test('connection secrets accept files, reject conflicts, and belong to the secret registry', t => {
  const directory = mkdtempSync(join(tmpdir(), 'cloud-connection-config-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'key');
  writeFileSync(file, 'test-file-key\n');
  assert.deepEqual(
    temporalConnectionOptions({
      TEMPORAL_API_KEY_FILE: file,
      TEMPORAL_TLS: 'true',
    }),
    {
      address: '127.0.0.1:7233',
      tls: true,
      apiKey: 'test-file-key',
    },
  );
  const web = publicWebConfiguration({
    HUNTSMAN_ENDPOINT: 'https://huntsman.example.com',
    HUNTSMAN_TOKEN_FILE: file,
  });
  assert.deepEqual(web.pages.headers, { authorization: 'Bearer test-file-key' });
  for (const name of ['TEMPORAL_API_KEY', 'HUNTSMAN_TOKEN', 'SEARXNG_TOKEN']) {
    assert.ok(secretSettingNames.includes(name));
    const config = name === 'TEMPORAL_API_KEY' ? temporalConnectionOptions : publicWebConfiguration;
    assert.throws(() => config({ [name]: 'direct-key', [`${name}_FILE`]: file }), /different values/);
    assert.throws(() => config({ [`${name}_FILE`]: join(directory, 'missing') }), /could not be read/);
  }
});

test('public web enables page reads and search separately, each with its own token', () => {
  assert.equal(publicWebConfiguration({}), undefined);
  assert.equal(publicWebConfiguration({ HUNTSMAN_ENDPOINT: '', SEARXNG_ENDPOINT: '', HUNTSMAN_TOKEN: '' }), undefined);
  const pages = publicWebConfiguration({ HUNTSMAN_ENDPOINT: 'http://huntsman:3000' });
  assert.equal(pages.search, undefined);
  assert.equal(pages.pages.endpoint.href, 'http://huntsman:3000/');
  assert.deepEqual(pages.pages.headers, {});
  assert.equal(pages.pages.healthPath, '/health');
  const search = publicWebConfiguration({ SEARXNG_ENDPOINT: 'http://searxng:8080', HUNTSMAN_TOKEN: 'test-key' });
  assert.equal(search.pages, undefined);
  assert.equal(search.search.endpoint.href, 'http://searxng:8080/');
  assert.deepEqual(search.search.headers, {});
  assert.equal(search.search.healthPath, '/healthz');
  const both = publicWebConfiguration({
    HUNTSMAN_ENDPOINT: 'https://huntsman.example.com',
    HUNTSMAN_TOKEN: 'test-key',
    SEARXNG_ENDPOINT: 'https://search.example.com',
  });
  assert.deepEqual(both.pages.headers, { authorization: 'Bearer test-key' });
  assert.deepEqual(both.search.headers, {});
  const proxied = publicWebConfiguration({
    SEARXNG_ENDPOINT: 'https://search.example.com',
    SEARXNG_TOKEN: 'search-key',
  });
  assert.deepEqual(proxied.search.headers, { authorization: 'Bearer search-key' });
  for (const name of ['HUNTSMAN_ENDPOINT', 'SEARXNG_ENDPOINT'])
    for (const endpoint of [
      ' ',
      'not a url',
      'https://user:pass@example.com',
      'https://example.com/v2',
      'file:///tmp/key',
    ])
      assert.throws(() => publicWebConfiguration({ [name]: endpoint }), new RegExp(name));
});

test('public web startup fails while a removed Firecrawl setting is set', () => {
  for (const name of ['FIRECRAWL_ENDPOINT', 'FIRECRAWL_API_KEY', 'FIRECRAWL_API_KEY_FILE'])
    assert.throws(
      () => publicWebConfiguration({ HUNTSMAN_ENDPOINT: 'http://huntsman:3000', [name]: 'old-value' }),
      error => error.message.includes(name) && /HUNTSMAN_/.test(error.message),
    );
  assert.throws(() => publicWebConfiguration({ FIRECRAWL_ENDPOINT: 'http://gateway:3002' }), /SEARXNG_ENDPOINT/);
  assert.equal(publicWebConfiguration({ FIRECRAWL_ENDPOINT: ' ' }), undefined);
});
