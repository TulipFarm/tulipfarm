import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import Fastify from 'fastify';
import swagger from '@fastify/swagger';
import { createGoogleOperations } from '@tulipfarm/google-workspace/operations';
import { googleFixture } from '../../../packages/google-workspace/test/fixture.mjs';
import { filesObjectFixture } from '../../../packages/workspaces/test/files-object-fixture.mjs';
import { authConfig } from '../src/auth.ts';
import { registerFilesComposition } from '../src/files-composition.ts';
import { registerFilesGoogleCopy } from '../src/files-google-copy.ts';
import { registerSecurity, securityServerOptions } from '../src/security.ts';

const docx = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

test(
  'Save a copy stores Google bytes once, replays without Google, and leaves no file or charge after failure',
  { timeout: 180000 },
  async () => {
    const f = await googleFixture();
    const object = await filesObjectFixture();
    const app = Fastify(securityServerOptions());
    const origin = authConfig().webOrigin;
    const sources = {
      doc: {
        meta: { id: 'doc-1', name: 'Field report', mimeType: 'application/vnd.google-apps.document', version: '7' },
        bytes: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0x10, 0x80]),
      },
      pdf: {
        meta: { id: 'pdf-1', name: 'Invoice.pdf', mimeType: 'application/pdf' },
        bytes: Buffer.from('%PDF-1.4\n%\xe2\xe3\n1 0 obj\n%%EOF\n', 'latin1'),
      },
      big: { meta: { id: 'big-1', name: 'Archive.zip', mimeType: 'application/zip' }, bytes: Buffer.alloc(2048, 7) },
      empty: { meta: { id: 'empty-1', name: 'Blank.txt', mimeType: 'text/plain' }, bytes: Buffer.alloc(0) },
    };
    const providerCalls = [];
    let behavior = 'normal';
    const provider = createServer((request, response) => {
      const url = new URL(request.url, 'http://provider');
      providerCalls.push(`${request.method} ${url.pathname}${url.search.includes('fields') ? '?fields' : url.search}`);
      assert.equal(request.method, 'GET', 'copying never writes to Google');
      const id = url.pathname.split('/')[4];
      const source = Object.values(sources).find(item => item.meta.id === id);
      if (!source) {
        response.writeHead(404, { 'content-type': 'application/json' });
        return response.end(JSON.stringify({ error: { errors: [{ reason: 'notFound' }] } }));
      }
      if (url.searchParams.has('fields')) {
        response.setHeader('content-type', 'application/json');
        return response.end(JSON.stringify(source.meta));
      }
      if (behavior === 'denied') {
        response.writeHead(403, { 'content-type': 'application/json' });
        return response.end(JSON.stringify({ error: { errors: [{ reason: 'insufficientFilePermissions' }] } }));
      }
      if (behavior === 'oversize') {
        response.writeHead(200, { 'content-type': source.meta.mimeType });
        return response.end(Buffer.alloc(10 * 1024 * 1024 + 1));
      }
      if (behavior === 'cut') {
        response.writeHead(200, {
          'content-type': source.meta.mimeType,
          'content-length': String(source.bytes.length),
        });
        response.write(source.bytes.subarray(0, 3));
        return response.destroy();
      }
      if (url.pathname.endsWith('/export')) assert.equal(url.searchParams.get('mimeType'), docx);
      else assert.equal(url.searchParams.get('alt'), 'media');
      response.writeHead(200, { 'content-type': url.pathname.endsWith('/export') ? docx : source.meta.mimeType });
      response.end(source.bytes);
    });
    try {
      provider.listen(0, '127.0.0.1');
      await once(provider, 'listening');
      const connected = await f.connect();
      const binding = {
        integrationId: connected.integrationId,
        accountId: connected.accountId,
        generation: connected.generation,
      };
      const auth = {
        api: {
          getSession: async ({ headers }) => {
            const userId = { 'session=member': f.member.userId, 'session=admin': f.admin.userId }[
              headers.get('cookie')
            ];
            return userId ? { user: { id: userId }, session: { id: 'fixture-session' } } : null;
          },
        },
      };
      const google = createGoogleOperations({
        runtime: f.runtime,
        integrations: f.service,
        fetcher: (url, init) => {
          assert.equal(url.origin, 'https://www.googleapis.com');
          return fetch(`http://127.0.0.1:${provider.address().port}${url.pathname}${url.search}`, init);
        },
      });
      registerSecurity(app, origin);
      await app.register(swagger, { openapi: { openapi: '3.0.3', info: { title: 'Files', version: '1' } } });
      await app.register(
        async routes => {
          const files = registerFilesComposition(routes, {
            runtime: f.runtime,
            auth,
            objects: object.adapter,
            quotaBytes: 1024,
          });
          registerFilesGoogleCopy(routes, { auth, files, google });
        },
        { prefix: '/v1' },
      );
      await app.listen({ host: '127.0.0.1', port: 0 });
      const base = `${app.listeningOrigin}/v1/workspaces/${f.workspace.id}/files`;
      async function call(path, { method = 'GET', body, cookie = 'session=member', headers = {} } = {}) {
        const response = await fetch(`${base}${path}`, {
          method,
          headers: { origin, cookie, ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        const bytes = Buffer.from(await response.arrayBuffer());
        return { status: response.status, bytes, json: () => JSON.parse(bytes.toString()) };
      }
      const copy = (id, input, options) =>
        call(`/${id}/google-copy`, {
          method: 'PUT',
          body: {
            name: 'Field report.docx',
            parentId: null,
            format: 'docx',
            ...input,
            source: { fileId: 'doc-1', expectedIntegration: binding, ...input?.source },
          },
          ...options,
        });
      const state = async () => ({
        rows: (
          await f.db.platform.query(`SELECT id,ready,size FROM ${f.table('tf_files')} WHERE kind='file' ORDER BY id`)
        ).rows,
        objects: [...object.objects.keys()].sort(),
      });

      const id = randomUUID();
      const first = await copy(id);
      assert.equal(first.status, 200, first.bytes.toString());
      assert.deepEqual(first.json(), {
        id,
        kind: 'file',
        name: 'Field report.docx',
        parentId: null,
        creatorMembershipId: f.member.membershipId,
        mediaType: docx,
        size: sources.doc.bytes.length,
        trashed: false,
        role: 'manager',
        deletion: null,
      });
      assert.deepEqual(
        (
          await f.db.platform.query(
            `SELECT provider,account_id,source_file_id,format,source_version,read_at IS NOT NULL AS read FROM ${f.table('tf_file_copy_sources')} WHERE file_id=$1`,
            [id],
          )
        ).rows,
        [
          {
            provider: 'google-drive',
            account_id: binding.accountId,
            source_file_id: 'doc-1',
            format: 'docx',
            source_version: '7',
            read: true,
          },
        ],
        'the copy records its Google source and the version read',
      );
      assert.deepEqual(
        (await call(`/${id}/content`)).bytes,
        sources.doc.bytes,
        'the stored copy is the Google export, byte for byte',
      );
      const settled = await state();
      const reads = providerCalls.length;
      assert.deepEqual((await copy(id)).json(), first.json(), 'a replay returns the same single file');
      assert.equal(providerCalls.length, reads, 'a replay does not read Google again');
      for (const changed of [{ source: { fileId: 'pdf-1' } }, { format: 'pdf' }, { name: 'Other.docx' }]) {
        const conflict = await copy(id, changed);
        assert.deepEqual(
          [conflict.status, conflict.json()],
          [409, { error: 'file-conflict' }],
          JSON.stringify(changed),
        );
      }
      assert.deepEqual(await state(), settled);

      const folder = randomUUID();
      assert.equal(
        (await call(`/${folder}/folder`, { method: 'PUT', body: { name: 'Invoices', parentId: null } })).status,
        200,
      );
      const original = randomUUID();
      const blob = await copy(original, {
        name: 'Invoice.pdf',
        parentId: folder,
        format: 'original',
        source: { fileId: 'pdf-1' },
      });
      assert.equal(blob.status, 200, blob.bytes.toString());
      assert.deepEqual([blob.json().parentId, blob.json().mediaType], [folder, 'application/pdf']);
      assert.equal(sha((await call(`/${original}/content`)).bytes), sha(sources.pdf.bytes));

      const hidden = randomUUID(),
        viewable = randomUUID();
      assert.equal(
        (
          await call(`/${hidden}/folder`, {
            method: 'PUT',
            cookie: 'session=admin',
            body: { name: 'Admin only', parentId: null },
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await call(`/${viewable}/folder`, {
            method: 'PUT',
            cookie: 'session=admin',
            body: { name: 'Read only', parentId: null },
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await call(`/${viewable}/sharing`, {
            method: 'PUT',
            cookie: 'session=admin',
            body: { subject: { kind: 'individual', id: f.member.membershipId }, role: 'viewer' },
          })
        ).status,
        200,
      );
      const before = providerCalls.length,
        untouched = await state();
      for (const parentId of [hidden, viewable, randomUUID()]) {
        const denied = await copy(randomUUID(), { parentId });
        assert.deepEqual([denied.status, denied.json()], [404, { error: 'file-not-found' }]);
      }
      assert.equal(providerCalls.length, before, 'an unwritable destination is refused before reading Google');
      assert.equal((await copy(randomUUID(), {}, { cookie: '' })).status, 401);
      assert.equal((await copy(randomUUID(), {}, { headers: { origin: 'https://evil.example' } })).status, 403);
      assert.equal((await copy(randomUUID(), { format: 'html' })).status, 400);
      assert.deepEqual(
        (await copy(randomUUID(), {}, { cookie: 'session=admin' })).json(),
        { error: 'integration-required' },
        'an administrator cannot use the member’s Google integration',
      );

      const failures = [
        ['quota', { name: 'Archive.zip', format: 'original', source: { fileId: 'big-1' } }, 409, 'file-quota'],
        ['empty', { name: 'Blank.txt', format: 'original', source: { fileId: 'empty-1' } }, 413, 'file-size'],
        ['denied', {}, 409, 'source-access-denied'],
        ['missing', { source: { fileId: 'gone-1' } }, 409, 'source-not-found'],
        ['oversize', {}, 409, 'response-too-large'],
        ['cut', {}, 409, 'provider-unavailable'],
        [
          'stale generation',
          { source: { expectedIntegration: { ...binding, generation: binding.generation + 1 } } },
          409,
          'reconnect-required',
        ],
        ['unsupported', { format: 'xlsx' }, 409, 'unsupported-representation'],
      ];
      for (const [label, input, status, error] of failures) {
        behavior = ['denied', 'oversize', 'cut'].includes(label) ? label : 'normal';
        const failed = await copy(randomUUID(), input);
        assert.deepEqual([failed.status, failed.json()], [status, { error }], label);
      }
      behavior = 'normal';
      assert.deepEqual(await state(), untouched, 'failed copies leave no row, no object, and no charge');

      const retried = randomUUID();
      object.faults.write = true;
      assert.equal((await copy(retried)).status, 500);
      object.faults.write = false;
      object.faults.corrupt = true;
      assert.equal((await copy(retried)).status, 502);
      object.faults.corrupt = false;
      assert.deepEqual(await state(), untouched, 'storage failures mid-transfer remove the attempt');
      assert.equal((await copy(retried)).status, 200, 'retrying the same command id completes it');
      assert.equal((await state()).rows.length, untouched.rows.length + 1);

      await f.service.disconnect(f.workspace.id, f.member.userId);
      const afterDisconnect = providerCalls.length;
      assert.deepEqual((await copy(id)).json(), first.json(), 'the copy no longer depends on Google access');
      assert.deepEqual((await call(`/${id}/content`)).bytes, sources.doc.bytes);
      assert.deepEqual((await copy(randomUUID())).json(), { error: 'integration-required' });
      const reconnected = await f.connect();
      const fresh = {
        integrationId: reconnected.integrationId,
        accountId: reconnected.accountId,
        generation: reconnected.generation,
      };
      assert.notEqual(fresh.generation, binding.generation);
      assert.deepEqual(
        (await copy(randomUUID())).json(),
        { error: 'reconnect-required' },
        'a copy started under the old generation is refused',
      );
      const renewed = await copy(randomUUID(), { source: { expectedIntegration: fresh } });
      assert.equal(renewed.status, 200, renewed.bytes.toString());
      assert.equal(
        providerCalls.slice(afterDisconnect).every(call => call.startsWith('GET ')),
        true,
      );
      assert.equal(JSON.stringify(app.swagger()).includes('copyGoogleFileToFilesV1'), true);
    } finally {
      await app.close();
      await object.close();
      await new Promise(resolve => provider.close(resolve));
      await f.close();
    }
  },
);
