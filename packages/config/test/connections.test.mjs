import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { temporalConnectionOptions } from '../dist/temporal.js';
import { publicWebConfiguration } from '../dist/public-web.js';
import { secretSettingNames } from '../dist/settings.js';

test('Temporal preserves local defaults and accepts explicit TLS and API-key options', () => {
  assert.deepEqual(temporalConnectionOptions({}), { address: '127.0.0.1:7233' });
  assert.deepEqual(temporalConnectionOptions({ TEMPORAL_ADDRESS: 'local:7233', TEMPORAL_TLS: '' }), {
    address: 'local:7233',
  });
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
  assert.deepEqual(temporalConnectionOptions({ TEMPORAL_API_KEY_FILE: file, TEMPORAL_TLS: 'true' }), {
    address: '127.0.0.1:7233',
    tls: true,
    apiKey: 'test-file-key',
  });
  const web = publicWebConfiguration({
    FIRECRAWL_ENDPOINT: 'https://cloud.example.com',
    FIRECRAWL_API_KEY_FILE: file,
  });
  assert.deepEqual(web.headers, { authorization: 'Bearer test-file-key' });
  for (const name of ['TEMPORAL_API_KEY', 'FIRECRAWL_API_KEY']) {
    assert.ok(secretSettingNames.includes(name));
    const config = name === 'TEMPORAL_API_KEY' ? temporalConnectionOptions : publicWebConfiguration;
    assert.throws(() => config({ [name]: 'direct-key', [`${name}_FILE`]: file }), /different values/);
    assert.throws(() => config({ [`${name}_FILE`]: join(directory, 'missing') }), /could not be read/);
  }
});

test('public web preserves keyless health and uses a read-only authenticated probe with a key', () => {
  assert.equal(publicWebConfiguration({}), undefined);
  const keyless = publicWebConfiguration({ FIRECRAWL_ENDPOINT: 'http://gateway:3002' });
  assert.equal(keyless.endpoint.href, 'http://gateway:3002/');
  assert.deepEqual(keyless.headers, {});
  assert.equal(keyless.healthPath, '/health');
  const cloud = publicWebConfiguration({
    FIRECRAWL_ENDPOINT: 'https://api.firecrawl.dev',
    FIRECRAWL_API_KEY: 'test-key',
  });
  assert.equal(cloud.healthPath, '/v2/team/credit-usage');
  assert.deepEqual(cloud.headers, { authorization: 'Bearer test-key' });
  for (const endpoint of ['https://user:pass@example.com', 'https://example.com/v2', 'file:///tmp/key'])
    assert.throws(() => publicWebConfiguration({ FIRECRAWL_ENDPOINT: endpoint }), /FIRECRAWL_ENDPOINT/);
});
