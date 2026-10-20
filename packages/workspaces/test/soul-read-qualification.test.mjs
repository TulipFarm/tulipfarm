import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import test from 'node:test';
import {
  qualifyProductionSoulRead,
  qualifySoulRead,
  productionReaderQualification,
  readerQualification,
} from '../src/soul-read-qualification.ts';

const env = {
  R2_SOUL_READ_ACCESS_KEY_ID: 'test-reader-id',
  R2_SOUL_READ_SECRET_ACCESS_KEY: 'test-reader-secret',
  R2_ACCESS_KEY_ID: 'test-writer-id',
  R2_SECRET_ACCESS_KEY: 'test-writer-secret',
};
const config = readerQualification(env);
const sensitive = 'DO-NOT-PRINT-REMOTE-EXCEPTION';

async function storage(t, faults = {}, mode = 'local') {
  const bucket = `tulipfarm-cloud-soul-${mode}`;
  const objects = new Map();
  const requests = [];
  function error(response, code, status) {
    response.writeHead(status, { 'content-type': 'application/xml' });
    response.end(`<Error><Code>${code}</Code><Message>${sensitive}</Message></Error>`);
  }
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const key = decodeURIComponent(url.pathname.replace(`/${bucket}/`, ''));
    const role = request.headers.authorization?.includes('Credential=test-reader-id/') ? 'reader' : 'writer';
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    requests.push({ role, method: request.method, key, headers: request.headers, body });
    assert.match(request.headers.authorization, /AWS4-HMAC-SHA256 Credential=test-(reader|writer)-id\//);
    assert.equal(request.headers['x-amz-security-token'], undefined);
    assert.equal(url.pathname.startsWith(`/${bucket}/qualification/soul-read/`), true);
    if (request.method === 'PUT') {
      assert.equal(request.headers['if-none-match'], '*');
      const object = {
        body,
        nonce: request.headers['x-amz-meta-qualification-nonce'],
        etag: `"${createHash('md5').update(body).digest('hex')}"`,
      };
      if (role === 'writer' && faults.fixture === 'collision') {
        objects.set(key, object);
        return error(response, faults.collisionCode ?? 'PreconditionFailed', 412);
      }
      if (objects.has(key)) return error(response, 'PreconditionFailed', 412);
      if (role === 'reader') {
        if (faults.readerPut === 'wrong403') return error(response, 'InvalidAccessKeyId', 403);
        if (faults.readerPut === 'wrongStatus') return error(response, 'AccessDenied', 400);
        if (faults.readerPut === 'collision') {
          objects.set(key, object);
          return error(response, 'PreconditionFailed', 412);
        }
        if (faults.readerPut === 'timeoutAbsent') return;
        if (faults.readerPut === 'deniedStored') {
          objects.set(key, object);
          return error(response, 'AccessDenied', 403);
        }
        if (!faults.readerPut) return error(response, 'AccessDenied', 403);
      }
      objects.set(key, object);
      if ((role === 'writer' && faults.fixture === 'lost') || (role === 'reader' && faults.readerPut === 'lost')) {
        request.socket.destroy();
        return;
      }
      if (role === 'reader' && faults.readerPut === 'timeoutStored') return;
      response.writeHead(200, { etag: object.etag });
      response.end();
      return;
    }
    if (request.method === 'GET') {
      if (role === 'reader' && faults.readerGet === 'denied')
        return error(response, faults.getCode ?? 'AccessDenied', faults.getStatus ?? 403);
      if (role === 'reader' && faults.readerGet === 'unsafeCode')
        return error(response, `${sensitive}-${key}-${env.R2_SOUL_READ_SECRET_ACCESS_KEY}`, 403);
      if (role === 'writer' && faults.cleanup === 'unreadable') return error(response, 'AccessDenied', 403);
      let object = objects.get(key);
      if (!object) return error(response, faults.absenceCode ?? 'NoSuchKey', 404);
      if (role === 'writer' && faults.cleanup === 'foreignNonce') {
        object = { ...object, nonce: 'foreign' };
        objects.set(key, object);
      }
      if (
        (role === 'reader' && faults.readerGet === 'wrongBytes') ||
        (role === 'writer' && faults.cleanup === 'foreignBytes')
      ) {
        object = { ...object, body: Buffer.alloc(object.body.length, 'x') };
        if (role === 'writer') objects.set(key, object);
      }
      if (role === 'reader' && faults.readerGet === 'wrongNonce') object = { ...object, nonce: 'foreign' };
      response.writeHead(200, {
        ...(role === 'reader' && faults.readerGet === 'missingEtag' ? {} : { etag: object.etag }),
        'content-length': object.body.length,
        'x-amz-meta-qualification-nonce': object.nonce,
      });
      if (role === 'reader' && faults.readerGet === 'stalledBody') {
        response.flushHeaders();
        response.write(object.body.subarray(0, 1));
        return;
      }
      response.end(object.body);
      return;
    }
    if (request.method === 'DELETE') {
      assert.equal(role, 'writer');
      if (faults.cleanup === 'replaceBeforeDelete') {
        objects.set(key, { body: Buffer.from('foreign replacement'), nonce: 'foreign', etag: '"replacement"' });
      }
      assert.ok(request.headers['if-match']);
      if (request.headers['if-match'] !== objects.get(key)?.etag) return error(response, 'PreconditionFailed', 412);
      if (faults.cleanup === 'deleteDenied') return error(response, 'AccessDenied', 403);
      if (faults.cleanup !== 'deleteIgnored') objects.delete(key);
      if (faults.cleanup === 'deleteLost') {
        request.socket.destroy();
        return;
      }
      response.writeHead(204);
      response.end();
      return;
    }
    assert.fail(`Unexpected operation ${request.method}`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise(resolve => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  );
  return {
    objects,
    requests,
    run: reportKeys =>
      (mode === 'production' ? qualifyProductionSoulRead : qualifySoulRead)(
        mode === 'production' ? productionReaderQualification({ ...env, NODE_ENV: 'production' }) : config,
        reportKeys,
        { endpoint: `http://127.0.0.1:${server.address().port}`, timeoutMs: 1000 },
      ),
  };
}

function summary(result) {
  return {
    status: result.status,
    action: result.action,
    writes: result.writes.map(({ outcome }) => outcome),
    cleanup: result.cleanup.map(({ code }) => code),
  };
}

for (const mode of ['local', 'production']) {
  test(`${mode} qualifies distinct signed reader credentials and removes its fixture with writer credentials`, async t => {
    const s3 = await storage(t, {}, mode);
    let announced;
    const result = await s3.run(keys => {
      announced = keys;
      assert.equal(s3.requests.length, 0);
    });
    assert.deepEqual(summary(result), {
      status: 'passed',
      action: 'qualified',
      writes: ['created', 'denied'],
      cleanup: ['deleted', 'absent'],
    });
    assert.deepEqual(
      announced,
      result.writes.map(({ key }) => key),
    );
    assert.equal(s3.objects.size, 0);
    assert.equal(s3.requests.filter(({ method }) => method === 'PUT').length, 2);
    assert.equal(s3.requests.filter(({ method }) => method === 'DELETE').length, 1);
    assert.equal(s3.requests.filter(({ role, method }) => role === 'reader' && method === 'GET').length, 1);
    assert.equal(s3.requests.filter(({ method, key }) => method === 'GET' && key.endsWith('/fixture')).length, 3);
  });

  test(`${mode} concurrent qualifications generate separate key prefixes and leave no objects`, async t => {
    const s3 = await storage(t, {}, mode);
    const results = await Promise.all([s3.run(), s3.run()]);
    assert.deepEqual(
      results.map(({ status }) => status),
      ['passed', 'passed'],
    );
    const keys = results.flatMap(({ writes }) => writes.map(({ key }) => key));
    assert.equal(new Set(keys).size, 4);
    for (const key of keys) assert.match(key, /^qualification\/soul-read\/[a-f0-9]{48}\/(fixture|denied-put)$/);
    assert.equal(s3.objects.size, 0);
  });

  for (const [readerPut, action, write, cleanup] of [
    ['wrong403', 'reader_write_unknown', 'unknown', 'unknown'],
    ['wrongStatus', 'reader_write_unknown', 'unknown', 'unknown'],
    ['allowed', 'reader_write_allowed', 'created', 'deleted'],
    ['lost', 'reader_write_unknown', 'unknown', 'deleted'],
    ['timeoutStored', 'reader_write_unknown', 'unknown', 'deleted'],
    ['timeoutAbsent', 'reader_write_unknown', 'unknown', 'unknown'],
    ['collision', 'reader_write_collision', 'collision', 'collision_preserved'],
  ]) {
    test(`${mode} reader PUT ${readerPut} fails without hiding its outcome`, async t => {
      const s3 = await storage(t, { readerPut }, mode);
      const result = await s3.run();
      assert.deepEqual(summary(result), {
        status: 'failed',
        action,
        writes: ['created', write],
        cleanup: ['deleted', cleanup],
      });
      assert.equal(s3.objects.size, readerPut === 'collision' ? 1 : 0);
      assert.equal(s3.requests.filter(({ method }) => method === 'PUT').length, 2);
      const output = JSON.stringify(result);
      for (const secret of [...Object.values(env), sensitive]) assert.equal(output.includes(secret), false);
    });
  }

  test(`${mode} lost fixture acknowledgement is reconciled but cannot qualify`, async t => {
    const s3 = await storage(t, { fixture: 'lost' }, mode);
    const result = await s3.run();
    assert.deepEqual(summary(result), {
      status: 'failed',
      action: 'fixture_write_unknown',
      writes: ['unknown', 'not_attempted'],
      cleanup: ['deleted', 'not_attempted'],
    });
    assert.equal(s3.objects.size, 0);
    assert.equal(s3.requests.filter(({ method }) => method === 'PUT').length, 1);
  });

  test(`${mode} writer 412 never adopts or deletes even a byte-identical nonce-matching collision`, async t => {
    const s3 = await storage(t, { fixture: 'collision' }, mode);
    const result = await s3.run();
    assert.deepEqual(summary(result), {
      status: 'failed',
      action: 'fixture_collision',
      writes: ['collision', 'not_attempted'],
      cleanup: ['collision_preserved', 'not_attempted'],
    });
    assert.equal(s3.objects.size, 1);
    assert.equal(s3.requests.length, 1);
  });

  test(`${mode} writer 412 with an unexpected error name still preserves the collision`, async t => {
    const s3 = await storage(t, { fixture: 'collision', collisionCode: 'UnexpectedPreconditionCode' }, mode);
    assert.deepEqual(summary(await s3.run()), {
      status: 'failed',
      action: 'fixture_collision',
      writes: ['collision', 'not_attempted'],
      cleanup: ['collision_preserved', 'not_attempted'],
    });
    assert.equal(s3.objects.size, 1);
    assert.equal(s3.requests.length, 1);
  });

  for (const [readerGet, action] of [
    ['denied', 'reader_get_failed'],
    ['wrongBytes', 'reader_get_mismatch'],
    ['wrongNonce', 'reader_get_mismatch'],
    ['missingEtag', 'reader_get_mismatch'],
    ['stalledBody', 'reader_get_failed'],
  ]) {
    test(`${mode} reader GET ${readerGet} fails and still cleans the fixture`, { timeout: 5000 }, async t => {
      const s3 = await storage(t, { readerGet }, mode);
      assert.deepEqual(summary(await s3.run()), {
        status: 'failed',
        action,
        writes: ['created', 'not_attempted'],
        cleanup: ['deleted', 'not_attempted'],
      });
      assert.equal(s3.objects.size, 0);
    });
  }

  for (const [cleanup, code, remaining] of [
    ['foreignNonce', 'foreign_preserved', 1],
    ['foreignBytes', 'foreign_preserved', 1],
    ['replaceBeforeDelete', 'unknown', 1],
    ['unreadable', 'unknown', 1],
    ['deleteDenied', 'unknown', 1],
    ['deleteIgnored', 'unknown', 1],
    ['deleteLost', 'unknown', 0],
  ]) {
    test(`${mode} cleanup ${cleanup} blocks a pass and preserves foreign data`, async t => {
      const s3 = await storage(t, { cleanup }, mode);
      const result = await s3.run();
      assert.deepEqual(summary(result), {
        status: 'failed',
        action: 'qualified',
        writes: ['created', 'denied'],
        cleanup: [code, cleanup === 'unreadable' ? 'unknown' : 'absent'],
      });
      assert.equal(s3.objects.size, remaining);
      if (cleanup === 'replaceBeforeDelete')
        assert.equal([...s3.objects.values()][0].body.toString(), 'foreign replacement');
      if (cleanup.startsWith('foreign'))
        assert.equal(s3.requests.filter(({ method }) => method === 'DELETE').length, 0);
    });
  }

  test(`${mode} a bucket-level 404 does not establish cleanup absence`, async t => {
    const s3 = await storage(t, { absenceCode: 'NoSuchBucket' }, mode);
    assert.deepEqual(summary(await s3.run()), {
      status: 'failed',
      action: 'qualified',
      writes: ['created', 'denied'],
      cleanup: ['unknown', 'unknown'],
    });
  });

  test(`${mode} never deletes a nonce-matching object after a denied reader write`, async t => {
    const s3 = await storage(t, { readerPut: 'deniedStored' }, mode);
    assert.deepEqual(summary(await s3.run()), {
      status: 'failed',
      action: 'qualified',
      writes: ['created', 'denied'],
      cleanup: ['deleted', 'foreign_preserved'],
    });
    assert.equal(s3.objects.size, 1);
    assert.equal(
      s3.requests.some(({ method, key }) => method === 'DELETE' && key.endsWith('/denied-put')),
      false,
    );
  });

  for (const [faults, diagnostic] of [
    [{ readerGet: 'denied' }, { code: 'AccessDenied', httpStatus: 403 }],
    [
      { readerGet: 'denied', getCode: 'InvalidAccessKeyId' },
      { code: 'InvalidAccessKeyId', httpStatus: 403 },
    ],
    [
      { readerGet: 'denied', getCode: 'SignatureDoesNotMatch' },
      { code: 'SignatureDoesNotMatch', httpStatus: 403 },
    ],
    [
      { readerGet: 'denied', getCode: 'ExpiredToken', getStatus: 400 },
      { code: 'ExpiredToken', httpStatus: 400 },
    ],
    [
      { readerGet: 'denied', getCode: 'InvalidToken' },
      { code: 'InvalidToken', httpStatus: 403 },
    ],
    [{ readerGet: 'unsafeCode' }, { code: 'unknown', httpStatus: 403 }],
    [{ readerGet: 'stalledBody' }, { code: 'unknown', httpStatus: null }],
  ]) {
    test(`${mode} reader GET diagnostic is closed and redacted for ${JSON.stringify(faults)}`, async t => {
      const s3 = await storage(t, faults, mode);
      const result = await s3.run();
      assert.equal(result.action, 'reader_get_failed');
      assert.deepEqual(result.diagnostic, diagnostic);
      assert.deepEqual(
        result.cleanup.map(({ code }) => code),
        ['deleted', 'not_attempted'],
      );
      assert.equal(
        s3.requests.some(({ role, method }) => role === 'reader' && method === 'PUT'),
        false,
      );
      const output = JSON.stringify(result);
      for (const secret of [...Object.values(env), sensitive]) assert.equal(output.includes(secret), false);
      for (const { key } of result.writes) assert.equal(JSON.stringify(result.diagnostic).includes(key), false);
    });
  }
}

test('configuration requires reader credentials without ambient or writer fallback', () => {
  assert.deepEqual(readerQualification(env), {
    reader: { accessKeyId: 'test-reader-id', secretAccessKey: 'test-reader-secret' },
    fixtureWriter: { accessKeyId: 'test-writer-id', secretAccessKey: 'test-writer-secret' },
  });
  for (const name of Object.keys(env)) {
    for (const value of [undefined, '', ' ', 'secret\n']) {
      assert.throws(
        () =>
          readerQualification({
            ...env,
            [name]: value,
            AWS_ACCESS_KEY_ID: 'ambient',
            AWS_SECRET_ACCESS_KEY: 'ambient',
          }),
        { message: 'explicit_credentials_required' },
      );
    }
  }
  assert.throws(() => readerQualification({ ...env, R2_SOUL_READ_ACCESS_KEY_ID: env.R2_ACCESS_KEY_ID }), {
    message: 'distinct_credentials_required',
  });
});

test('configuration rejects production, target conflicts and session tokens', () => {
  assert.throws(() => readerQualification({ ...env, NODE_ENV: 'production' }), { message: 'production_forbidden' });
  for (const name of [
    'R2_SOUL_BUCKET',
    'R2_ACCOUNT_ID',
    'CLOUDFLARE_ACCOUNT_ID',
    'R2_SOUL_ACCOUNT_ID',
    'R2_ENDPOINT',
    'R2_S3_ENDPOINT',
    'R2_SOUL_ENDPOINT',
    'AWS_ENDPOINT_URL',
    'AWS_ENDPOINT_URL_S3',
  ]) {
    assert.throws(() => readerQualification({ ...env, [name]: 'wrong-target' }), { message: 'target_conflict' });
  }
  for (const name of [
    'R2_SESSION_TOKEN',
    'R2_SOUL_READ_SESSION_TOKEN',
    'R2_SOUL_SESSION_TOKEN',
    'AWS_SESSION_TOKEN',
    'AWS_SECURITY_TOKEN',
  ]) {
    assert.throws(() => readerQualification({ ...env, [name]: 'token' }), { message: 'session_token_unsupported' });
  }
});

test('production configuration fixes the account, endpoint and bucket and requires explicit distinct durable credentials', () => {
  const targets = {
    R2_SOUL_BUCKET: 'tulipfarm-cloud-soul-production',
    R2_ACCOUNT_ID: '8814d00cb5fea3365054df9cee16776b',
    CLOUDFLARE_ACCOUNT_ID: '8814d00cb5fea3365054df9cee16776b',
    R2_SOUL_ACCOUNT_ID: '8814d00cb5fea3365054df9cee16776b',
    R2_ENDPOINT: 'https://8814d00cb5fea3365054df9cee16776b.r2.cloudflarestorage.com',
    R2_S3_ENDPOINT: 'https://8814d00cb5fea3365054df9cee16776b.r2.cloudflarestorage.com',
    R2_SOUL_ENDPOINT: 'https://8814d00cb5fea3365054df9cee16776b.r2.cloudflarestorage.com',
    AWS_ENDPOINT_URL: 'https://8814d00cb5fea3365054df9cee16776b.r2.cloudflarestorage.com',
    AWS_ENDPOINT_URL_S3: 'https://8814d00cb5fea3365054df9cee16776b.r2.cloudflarestorage.com',
  };
  const expected = {
    reader: { accessKeyId: 'test-reader-id', secretAccessKey: 'test-reader-secret' },
    fixtureWriter: { accessKeyId: 'test-writer-id', secretAccessKey: 'test-writer-secret' },
  };
  assert.deepEqual(productionReaderQualification({ ...env, ...targets, NODE_ENV: 'production' }), expected);
  assert.deepEqual(productionReaderQualification(env), expected);
  for (const name of Object.keys(targets)) {
    for (const value of ['wrong-target', '']) {
      assert.throws(() => productionReaderQualification({ ...env, [name]: value }), { message: 'target_conflict' });
    }
  }
  assert.throws(() => productionReaderQualification({ ...env, R2_SOUL_BUCKET: 'tulipfarm-cloud-soul-local' }), {
    message: 'target_conflict',
  });
  assert.throws(() => readerQualification({ ...env, R2_SOUL_BUCKET: targets.R2_SOUL_BUCKET }), {
    message: 'target_conflict',
  });
  for (const name of Object.keys(env)) {
    for (const value of [undefined, '', ' ', 'secret\n']) {
      assert.throws(
        () =>
          productionReaderQualification({
            ...env,
            [name]: value,
            AWS_ACCESS_KEY_ID: 'ambient',
            AWS_SECRET_ACCESS_KEY: 'ambient',
          }),
        { message: 'explicit_credentials_required' },
      );
    }
  }
  assert.throws(() => productionReaderQualification({ ...env, R2_SOUL_READ_ACCESS_KEY_ID: env.R2_ACCESS_KEY_ID }), {
    message: 'distinct_credentials_required',
  });
  for (const name of [
    'R2_SESSION_TOKEN',
    'R2_SOUL_READ_SESSION_TOKEN',
    'R2_SOUL_SESSION_TOKEN',
    'AWS_SESSION_TOKEN',
    'AWS_SECURITY_TOKEN',
  ]) {
    for (const value of ['', 'token']) {
      assert.throws(() => productionReaderQualification({ ...env, [name]: value }), {
        message: 'session_token_unsupported',
      });
    }
  }
});

test('both runners reject non-loopback test transports before announcing probes', async () => {
  for (const run of [qualifySoulRead, qualifyProductionSoulRead]) {
    for (const endpoint of [
      'https://127.0.0.1',
      'http://localhost',
      'http://127.0.0.2',
      'http://127.0.0.1/path',
      'http://user:password@127.0.0.1',
      'http://127.0.0.1?target=production',
      'http://127.0.0.1#fragment',
      'https://8814d00cb5fea3365054df9cee16776b.r2.cloudflarestorage.com',
    ]) {
      await assert.rejects(
        run(config, () => assert.fail('must reject before probes'), { endpoint, timeoutMs: 1000 }),
        { message: 'target_conflict' },
      );
    }
    for (const timeoutMs of [0, 10_001, 1.5]) {
      await assert.rejects(
        run(config, () => assert.fail('must reject before probes'), { endpoint: 'http://127.0.0.1', timeoutMs }),
        { message: 'target_conflict' },
      );
    }
  }
});

test('production CLI fails closed with safe output and accepts no target or credential arguments', () => {
  const file = new URL('../src/soul-read-production-qualification.ts', import.meta.url);
  for (const [args, extraEnv, code] of [
    [[], {}, 'explicit_credentials_required'],
    [
      [],
      { NODE_ENV: 'production', AWS_ACCESS_KEY_ID: 'ambient', AWS_SECRET_ACCESS_KEY: 'ambient' },
      'explicit_credentials_required',
    ],
    [[], { ...env, R2_SOUL_BUCKET: 'tulipfarm-cloud-soul-local' }, 'target_conflict'],
    [[], { ...env, R2_ENDPOINT: `https://${sensitive}.invalid` }, 'target_conflict'],
    [[], { ...env, AWS_SESSION_TOKEN: sensitive }, 'session_token_unsupported'],
    [[], { ...env, R2_SOUL_READ_ACCESS_KEY_ID: env.R2_ACCESS_KEY_ID }, 'distinct_credentials_required'],
    [['--endpoint', 'http://127.0.0.1:1'], env, 'arguments_forbidden'],
    [['--bucket', 'tulipfarm-cloud-soul-local'], env, 'arguments_forbidden'],
    [['--key', sensitive], env, 'arguments_forbidden'],
  ]) {
    const child = spawnSync(process.execPath, [file.pathname, ...args], {
      env: extraEnv,
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.equal(child.status, 1);
    assert.equal(child.stdout, '');
    assert.equal(child.stderr, `${JSON.stringify({ status: 'failed', code })}\n`);
  }
});

test('CLI fails closed with safe output and accepts no target or key arguments', () => {
  const file = new URL('../src/soul-read-qualification.ts', import.meta.url);
  for (const [args, extraEnv, code] of [
    [[], {}, 'explicit_credentials_required'],
    [[], { ...env, NODE_ENV: 'production' }, 'production_forbidden'],
    [[], { ...env, R2_ENDPOINT: `https://${sensitive}.invalid` }, 'target_conflict'],
    [['--endpoint', 'http://127.0.0.1:1'], env, 'arguments_forbidden'],
    [['--production'], env, 'arguments_forbidden'],
    [['--bucket', 'tulipfarm-cloud-soul-production'], env, 'arguments_forbidden'],
    [['--key', sensitive], env, 'arguments_forbidden'],
  ]) {
    const child = spawnSync(process.execPath, [file.pathname, ...args], {
      env: extraEnv,
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.equal(child.status, 1);
    assert.equal(child.stdout, '');
    assert.equal(child.stderr, `${JSON.stringify({ status: 'failed', code })}\n`);
  }
});
