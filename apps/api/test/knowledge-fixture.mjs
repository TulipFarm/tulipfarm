import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import Fastify from 'fastify';
import { AccessDenied } from '@tulipfarm/access';
import { createWorkspaceRuntime, qualified } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import { fixture, markWorkspaceReady } from '../../../packages/workspace-storage/test/integration/fixture.mjs';
import { filesObjectFixture } from '../../../packages/workspaces/test/files-object-fixture.mjs';
import { authenticatedFixture } from './auth-fixture.mjs';
import { registerFilesComposition } from '../dist/files-composition.js';
import { registerKnowledgeComposition } from '../dist/knowledge-composition.js';
import { securityServerOptions } from '../dist/security.js';
import { createGoogleWorkspaceService } from '@tulipfarm/google-workspace';
import { registerGoogleWorkspace } from '../dist/google-workspace.js';

export async function knowledgeFixture({
  filesEnabled = true,
  embeddings = {},
  googleOptions,
  temporal,
  slackCorpus,
  githubCorpus,
  atlassianCorpus,
} = {}) {
  const db = await fixture();
  let runtime, identity, object, app;
  try {
    await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
    const stream = await workspaceTableMigrations();
    assert.ok(stream.some(migration => migration.name === '0001_baseline.sql'));
    const signed = await authenticatedFixture(db);
    identity = signed.identity;
    const workspace = await db.create(stream, { userId: signed.owner.id }),
      other = await db.create(stream, { userId: signed.admin.id });
    const table = name => qualified(workspace.names.schema, name);
    const adminMembership = await signed.addAdmin(workspace);
    runtime = createWorkspaceRuntime({
      replicaCount: 1,
      reservedConnections: 2,
      databaseConnectionBudget: 24,
      resolveCredential: async id => {
        const target = [workspace, other].find(item => item.id === id);
        if (!target) throw new AccessDenied();
        return { workspaceId: id, generation: 1, connectionString: db.login(target) };
      },
    });
    object = await filesObjectFixture();
    const googleService = googleOptions ? createGoogleWorkspaceService({ runtime, ...googleOptions }) : undefined;
    if (temporal) {
      await markWorkspaceReady(db.platform, workspace.id);
    }
    let service, files;
    app = Fastify(securityServerOptions());
    app.register(
      async routes => {
        files = filesEnabled
          ? registerFilesComposition(routes, { runtime, auth: signed.auth, objects: object.adapter, identity })
          : undefined;
        service = registerKnowledgeComposition(routes, {
          runtime,
          auth: signed.auth,
          files,
          pool: signed.identity,
          ...embeddings,
          ...(googleService ? { googleService, providerFetch: googleOptions.providerFetch } : {}),
          ...(temporal ? { temporal } : {}),
          ...(slackCorpus ? { slackCorpus: slackCorpus(runtime) } : {}),
          ...(githubCorpus ? { githubCorpus: githubCorpus(runtime) } : {}),
          ...(atlassianCorpus ? { atlassianCorpus: atlassianCorpus(runtime) } : {}),
        });
        if (googleService) registerGoogleWorkspace(routes, { auth: signed.auth, service: googleService });
      },
      { prefix: '/v1' },
    );
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    const base = `/v1/workspaces/${workspace.id}/knowledge`;
    async function call(
      path = '/documents',
      { method = 'GET', body, cookie = signed.owner.cookie, headers = {} } = {},
    ) {
      const response = await fetch(`${origin}${path.startsWith('/v1/') ? path : base + path}`, {
        method,
        headers: {
          cookie,
          origin: 'http://localhost:5173',
          ...(body === undefined
            ? {}
            : { 'content-type': Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json' }),
          ...headers,
        },
        ...(body === undefined ? {} : { body: Buffer.isBuffer(body) ? body : JSON.stringify(body) }),
      });
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(response.headers.get('cache-control'), 'no-store');
      return { status: response.status, headers: response.headers, bytes, json: () => JSON.parse(bytes.toString()) };
    }
    const command = (
      input = { kind: 'note', text: '# Returns\nReturn orders within thirty days. Track OPS-123.' },
    ) => ({
      commandId: randomUUID(),
      expectedRevisionId: null,
      title: 'Returns handbook',
      input,
    });
    const save = (id, body, options = {}) => call(`/documents/${id}`, { ...options, method: 'PUT', body });
    const upload = (id, bytes, name = 'Policy.txt', mediaType = 'text/plain') =>
      call(
        `/v1/workspaces/${workspace.id}/files/${id}/content?${new URLSearchParams({ name, mediaType, parentId: 'null' })}`,
        { method: 'PUT', body: Buffer.from(bytes) },
      );
    const share = (id, role) =>
      call(`/v1/workspaces/${workspace.id}/files/${id}/sharing`, {
        method: 'PUT',
        body: { subject: { kind: 'individual', id: adminMembership }, role },
      });
    const process = async revisionId => {
      const work = (await service.due(workspace.id)).find(item => item.revisionId === revisionId);
      assert.ok(work, 'saved revision is durable due work');
      await service.acknowledge(work);
      return service.process(work);
    };
    return {
      db,
      workspace,
      other,
      table,
      signed,
      adminMembership,
      runtime,
      object,
      app,
      service,
      files,
      googleService,
      origin,
      base,
      call,
      command,
      save,
      upload,
      share,
      process,
      close: async () => {
        await app.close();
        await object.close();
        await runtime.close();
        await identity.end();
        await db.close();
      },
    };
  } catch (error) {
    await app?.close();
    await object?.close();
    await runtime?.close();
    await identity?.end();
    await db.close();
    throw error;
  }
}
