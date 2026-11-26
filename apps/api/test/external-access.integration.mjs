// Access tokens, the public REST API and the MCP server, end to end against a disposable Postgres.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import Fastify from 'fastify';
import pg from 'pg';
import { createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import { fixture } from '../../../packages/workspace-storage/test/integration/fixture.mjs';
import { createTableWithRows, tableDefinition, textField, textValues } from '../../../packages/tables/test/fixture.mjs';
import { filesObjectFixture } from '../../../packages/workspaces/test/files-object-fixture.mjs';
import { createAuth } from '../src/auth.ts';
import { createAccessTokens } from '../src/access-tokens.ts';
import { registerAccessTokenSettings } from '../src/access-token-routes.ts';
import { createExternalApi } from '../src/external-api.ts';
import { createTokenLimiter, registerPublicApi } from '../src/public-api.ts';
import { registerPublicMcp } from '../src/public-mcp.ts';
import { createFilesService } from '../src/files-service.ts';

const migration = name => readFile(new URL(`../../database/migrations/${name}`, import.meta.url), 'utf8');

test(
  'access tokens reach workspace data through REST and MCP only as their scopes allow',
  { timeout: 180000 },
  async t => {
    const check = (name, work) => t.test(name, work);
    const db = await fixture();
    await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
  ${await migration('0001_baseline.sql')}`);
    await db.platform.query(`SET search_path TO app; ${await migration('0020_access_tokens.sql')}`);
    const pool = new pg.Pool({ connectionString: db.connectionString, options: '-c search_path=app' });
    let link;
    const auth = createAuth(
      pool,
      async data => void (link = data.url),
      async () => {},
    );
    async function login(name) {
      await auth.api.signInMagicLink({
        headers: new Headers({ origin: 'http://localhost:5173' }),
        body: { email: `${randomUUID()}@example.com`, name },
      });
      const result = await auth.handler(new Request(link));
      const cookie = result.headers
        .getSetCookie()
        .map(value => value.split(';')[0])
        .join('; ');
      const session = await auth.api.getSession({ headers: new Headers({ cookie }) });
      return { cookie, userId: session.user.id };
    }
    const owner = await login('Owner'),
      member = await login('Member'),
      stranger = await login('Stranger');
    const migrations = await workspaceTableMigrations();
    const workspace = await db.create(migrations, { userId: owner.userId });
    const other = await db.create(migrations, { userId: stranger.userId });
    await db.platform
      .query(
        `INSERT INTO app.workspaces(id,request_id,created_by,name,slug) VALUES($1,$2,$3,'Acme','acme') ON CONFLICT (id) DO NOTHING`,
        [workspace.id, randomUUID(), owner.userId],
      )
      .catch(() => {});
    const s = `"${workspace.names.schema}"`;
    const memberMembership = randomUUID();
    await db.platform.query(`INSERT INTO ${s}.tf_memberships(id,user_id,role) VALUES($1,$2,'member')`, [
      memberMembership,
      member.userId,
    ]);
    const team = randomUUID();
    await db.platform.query(`INSERT INTO ${s}.tf_teams(id,name) VALUES($1,'Ops')`, [team]);
    const runtime = createWorkspaceRuntime({
      resolveCredential: async id => {
        const target = [workspace, other].find(item => item.id === id);
        return { workspaceId: id, generation: 1, connectionString: db.login(target) };
      },
      replicaCount: 1,
      reservedConnections: 2,
      databaseConnectionBudget: 30,
    });
    const name = textField('Name');
    const leads = await createTableWithRows({
      db,
      workspace: { ...workspace, userId: owner.userId },
      runtime,
      definition: tableDefinition({ owningTeamId: team, label: 'Leads', fields: [name] }),
      records: [{ values: textValues(name, 'Ada') }],
    });
    const secret = await createTableWithRows({
      db,
      workspace: { ...workspace, userId: owner.userId },
      runtime,
      definition: tableDefinition({ owningTeamId: team, label: 'Secret', fields: [textField('X')] }),
    });
    const object = await filesObjectFixture();
    const app = Fastify();
    const tokens = createAccessTokens({ pool, runtime, flag: async () => true });
    const woken = [];
    const externalApi = createExternalApi({
      runtime,
      files: createFilesService(app.log, { runtime, objects: object.adapter }),
      wakeTask: async (ws, id) => void woken.push(id),
      appOrigin: 'http://localhost:5173',
      workspaceSlug: async () => 'acme',
    });
    app.register(
      async v1 => {
        v1.register(async business => registerAccessTokenSettings(business, auth, tokens));
        v1.register(async external => {
          const limiter = createTokenLimiter();
          external.register(async routes => registerPublicApi(routes, { tokens, api: externalApi, limiter }), {
            prefix: '/public',
          });
          registerPublicMcp(external, { tokens, api: externalApi, limiter });
        });
      },
      { prefix: '/v1' },
    );
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    const call = async (path, { method = 'GET', body, cookie, token, headers = {} } = {}) => {
      const response = await fetch(`${origin}${path}`, {
        method,
        headers: {
          ...(cookie ? { cookie, origin: 'http://localhost:5173' } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body === undefined
            ? {}
            : { 'content-type': Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json' }),
          ...headers,
        },
        ...(body === undefined ? {} : { body: Buffer.isBuffer(body) ? body : JSON.stringify(body) }),
      });
      const text = await response.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        json = text;
      }
      return { status: response.status, json, headers: response.headers };
    };
    const ws = `/v1/workspaces/${workspace.id}`;
    const pub = `/v1/public/workspaces/${workspace.id}`;
    const expect = (result, status) =>
      assert.equal(result.status, status, `expected ${status}, got ${result.status}: ${JSON.stringify(result.json)}`);

    let full, readOnly, limited;
    await check('settings: off by default, owner is admin', async () => {
      const r = await call(`${ws}/external-access`, { cookie: owner.cookie });
      expect(r, 200);
      assert.deepEqual(r.json, { available: true, enabled: false, admin: true });
    });
    await check('token creation refused while external access is off', async () => {
      const r = await call(`${ws}/access-tokens`, {
        method: 'POST',
        cookie: owner.cookie,
        body: { name: 'x', scopes: ['tables:read'], expiry: '30d' },
      });
      expect(r, 409);
      assert.equal(r.json.error, 'external-access-disabled');
    });
    await check('a member cannot turn external access on', async () => {
      expect(
        await call(`${ws}/external-access`, { method: 'PUT', cookie: member.cookie, body: { enabled: true } }),
        403,
      );
    });
    await check('admin turns external access on', async () => {
      const r = await call(`${ws}/external-access`, { method: 'PUT', cookie: owner.cookie, body: { enabled: true } });
      expect(r, 200);
      assert.equal(r.json.enabled, true);
    });
    await check('create tokens; secret shown once and stored hashed', async () => {
      const all = ['tables:read', 'tables:write', 'files:read', 'files:write', 'agents:run'];
      let r = await call(`${ws}/access-tokens`, {
        method: 'POST',
        cookie: owner.cookie,
        body: { name: 'Laptop sync', scopes: all, expiry: '90d' },
      });
      expect(r, 201);
      full = r.json.token;
      assert.match(full, /^tfp_[0-9a-f]{32}_[A-Za-z0-9_-]{43}$/);
      assert.equal(r.json.accessToken.name, 'Laptop sync');
      const stored = await db.platform.query(
        'SELECT encode(secret_sha256,$2) AS h FROM app.access_tokens WHERE id=$1',
        [r.json.accessToken.id, 'hex'],
      );
      assert.ok(!JSON.stringify(stored.rows).includes(full.slice(-43)));
      r = await call(`${ws}/access-tokens`, {
        method: 'POST',
        cookie: owner.cookie,
        body: { name: 'Reader', scopes: ['tables:read'], expiry: 'never' },
      });
      readOnly = r.json.token;
      r = await call(`${ws}/access-tokens`, {
        method: 'POST',
        cookie: owner.cookie,
        body: { name: 'Leads only', scopes: ['tables:read'], tableIds: [leads.tableId], expiry: '30d' },
      });
      limited = r.json.token;
    });
    await check('list own tokens never returns the secret', async () => {
      const r = await call(`${ws}/access-tokens`, { cookie: owner.cookie });
      expect(r, 200);
      assert.equal(r.json.tokens.length, 3);
      assert.ok(!JSON.stringify(r.json).includes('tfp_'));
    });
    await check('a member cannot list everyone’s tokens', async () => {
      expect(await call(`${ws}/access-tokens?scope=all`, { cookie: member.cookie }), 403);
    });
    await check('REST without a token is 401', async () => {
      const r = await call(`${pub}/tables`);
      expect(r, 401);
      assert.equal(r.json.error.code, 'invalid-token');
    });
    await check('REST rejects cookie plus token', async () => {
      expect(await call(`${pub}/tables`, { token: full, cookie: owner.cookie }), 400);
    });
    await check('REST rejects a forged token', async () => {
      expect(await call(`${pub}/tables`, { token: full.slice(0, -2) + 'AA' }), 401);
    });
    await check('REST lists tables', async () => {
      const r = await call(`${pub}/tables`, { token: full });
      expect(r, 200);
      const names = r.json.tables.map(t => t.name);
      assert.ok(names.includes('Leads') && names.includes('Secret'), JSON.stringify(names));
      assert.equal(r.headers.get('cache-control'), 'no-store');
    });
    await check('table-limited token sees only its table, and 404 for the other', async () => {
      const r = await call(`${pub}/tables`, { token: limited });
      assert.deepEqual(
        r.json.tables.map(t => t.name),
        ['Leads'],
      );
      expect(await call(`${pub}/tables/${secret.tableId}`, { token: limited }), 404);
    });
    await check('token for another workspace is 404', async () => {
      expect(await call(`/v1/public/workspaces/${other.id}/tables`, { token: full }), 404);
    });
    await check('describe table shows fields and revision', async () => {
      const r = await call(`${pub}/tables/${leads.tableId}`, { token: full });
      expect(r, 200);
      assert.equal(r.json.definition.fields[0].label, 'Name');
    });
    let created;
    await check('create rows needs an Idempotency-Key', async () => {
      expect(
        await call(`${pub}/tables/${leads.tableId}/rows`, {
          method: 'POST',
          token: full,
          body: { rows: [{ values: textValues(name, 'Bob') }] },
        }),
        400,
      );
    });
    await check('create rows, then a retry with the same key replays without duplicates', async () => {
      const body = {
        rows: [{ values: textValues(name, 'Bob') }, { id: randomUUID(), values: textValues(name, 'Cy') }],
      };
      const first = await call(`${pub}/tables/${leads.tableId}/rows`, {
        method: 'POST',
        token: full,
        body,
        headers: { 'idempotency-key': 'import-1' },
      });
      expect(first, 200);
      assert.deepEqual(
        first.json.results.map(r => r.status),
        ['created', 'created'],
        JSON.stringify(first.json),
      );
      const again = await call(`${pub}/tables/${leads.tableId}/rows`, {
        method: 'POST',
        token: full,
        body,
        headers: { 'idempotency-key': 'import-1' },
      });
      assert.deepEqual(
        again.json.results.map(r => r.row.id),
        first.json.results.map(r => r.row.id),
      );
      const list = await call(`${pub}/tables/${leads.tableId}/rows`, { token: full });
      assert.equal(list.json.rows.length, 3, JSON.stringify(list.json));
      created = first.json.results[0].row;
    });
    await check('same key with different content is a 409 conflict', async () => {
      const r = await call(`${pub}/tables/${leads.tableId}/rows`, {
        method: 'POST',
        token: full,
        body: { rows: [{ values: textValues(name, 'Zed') }] },
        headers: { 'idempotency-key': 'import-1' },
      });
      expect(r, 409);
      assert.equal(r.json.error.code, 'idempotency-conflict');
    });
    await check('a failed row names its field and reason, and the other rows still succeed', async () => {
      const r = await call(`${pub}/tables/${leads.tableId}/rows`, {
        method: 'POST',
        token: full,
        body: {
          rows: [{ values: textValues(name, 'Eve') }, { values: { [randomUUID()]: { kind: 'text', value: 'x' } } }],
        },
        headers: { 'idempotency-key': 'mixed-1' },
      });
      expect(r, 200);
      assert.deepEqual(
        r.json.results.map(row => row.status),
        ['created', 'failed'],
      );
      assert.equal(r.json.results[1].error.code, 'invalid-values');
      assert.ok(r.json.results[1].error.message && r.json.results[1].error.fieldId, JSON.stringify(r.json));
    });
    await check('malformed JSON is 400 invalid-json, and an unknown table is 404', async () => {
      const response = await fetch(`${origin}${pub}/tables/${leads.tableId}/rows/query`, {
        method: 'POST',
        headers: { authorization: `Bearer ${full}`, 'content-type': 'application/json' },
        body: '{"limit":',
      });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error.code, 'invalid-json');
      const missing = await call(`${pub}/tables/${randomUUID()}`, { token: full });
      expect(missing, 404);
      assert.equal(missing.json.error.code, 'table-not-found');
    });
    await check('request status reports applied', async () => {
      const r = await call(`${pub}/tables/${leads.tableId}/requests?key=import-1&kind=create&index=0`, { token: full });
      expect(r, 200);
      assert.equal(r.json.status, 'applied');
    });
    await check('read-only token cannot write (403 insufficient-scope)', async () => {
      const r = await call(`${pub}/tables/${leads.tableId}/rows`, {
        method: 'POST',
        token: readOnly,
        body: { rows: [{ values: textValues(name, 'X') }] },
        headers: { 'idempotency-key': 'k' },
      });
      expect(r, 403);
      assert.equal(r.json.error.code, 'insufficient-scope');
    });
    await check('update with current token works; stale token is 409', async () => {
      const ok = await call(`${pub}/tables/${leads.tableId}/rows/${created.id}`, {
        method: 'PATCH',
        token: full,
        body: { expectedToken: created.token, values: textValues(name, 'Bobby') },
        headers: { 'idempotency-key': 'u1' },
      });
      expect(ok, 200);
      const stale = await call(`${pub}/tables/${leads.tableId}/rows/${created.id}`, {
        method: 'PATCH',
        token: full,
        body: { expectedToken: created.token, values: textValues(name, 'B2') },
        headers: { 'idempotency-key': 'u2' },
      });
      expect(stale, 409);
      assert.equal(stale.json.error.code, 'stale-record');
      const row = await call(`${pub}/tables/${leads.tableId}/rows/${created.id}`, { token: full });
      assert.equal(row.json.values[name.id].value, 'Bobby');
      created = row.json;
    });
    await check('query rows with search', async () => {
      const r = await call(`${pub}/tables/${leads.tableId}/rows/query`, {
        method: 'POST',
        token: full,
        body: { search: 'Ada' },
      });
      expect(r, 200);
      assert.equal(r.json.rows.length, 1);
    });
    await check('delete row', async () => {
      const r = await call(`${pub}/tables/${leads.tableId}/rows/${created.id}`, {
        method: 'DELETE',
        token: full,
        body: { expectedToken: created.token },
        headers: { 'idempotency-key': 'd1' },
      });
      expect(r, 200);
      expect(await call(`${pub}/tables/${leads.tableId}/rows/${created.id}`, { token: full }), 404);
    });
    let fileId;
    await check('upload, list and download a file', async () => {
      const up = await call(`${pub}/files?name=notes.md&mediaType=text/markdown`, {
        method: 'POST',
        token: full,
        body: Buffer.from('# hello'),
        headers: { 'idempotency-key': 'f1' },
      });
      expect(up, 201);
      fileId = up.json.id;
      const again = await call(`${pub}/files?name=notes.md&mediaType=text/markdown`, {
        method: 'POST',
        token: full,
        body: Buffer.from('# hello'),
        headers: { 'idempotency-key': 'f1' },
      });
      assert.ok([201, 409].includes(again.status), `retry: ${again.status} ${JSON.stringify(again.json)}`);
      const list = await call(`${pub}/files`, { token: full });
      expect(list, 200);
      assert.equal(list.json.items.filter(i => i.name === 'notes.md').length, 1, JSON.stringify(list.json));
      const down = await call(`${pub}/files/${fileId}/content`, { token: full });
      expect(down, 200);
      assert.equal(down.json, '# hello');
    });
    await check('agents list works (empty workspace)', async () => {
      const r = await call(`${pub}/agents`, { token: full });
      expect(r, 200);
      assert.deepEqual(r.json.agents, []);
    });

    const mcp = async (token, method, params = {}, id = 1) => {
      const r = await call('/v1/mcp', {
        method: 'POST',
        token,
        headers: { accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
        body: { jsonrpc: '2.0', id, method, params },
      });
      return r;
    };
    await check('MCP initialize', async () => {
      const r = await mcp(full, 'initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'verify', version: '0' },
      });
      expect(r, 200);
      assert.equal(r.json.result.serverInfo.name, 'tulipfarm');
      assert.match(r.json.result.instructions, /treat them as/);
    });
    await check('MCP lists tools by scope', async () => {
      const fullTools = (await mcp(full, 'tools/list')).json.result.tools.map(t => t.name);
      for (const tool of ['list_tables', 'create_rows', 'read_file', 'upload_file', 'run_agent', 'get_task'])
        assert.ok(fullTools.includes(tool), `${tool} missing: ${fullTools}`);
      const readTools = (await mcp(readOnly, 'tools/list')).json.result.tools.map(t => t.name);
      assert.deepEqual(readTools.sort(), ['describe_table', 'get_row', 'list_tables', 'query_rows']);
    });
    await check('MCP list_tables and create_rows', async () => {
      let r = await mcp(full, 'tools/call', { name: 'list_tables', arguments: {} });
      assert.ok(
        r.json.result.structuredContent.tables.some(t => t.name === 'Leads'),
        JSON.stringify(r.json),
      );
      r = await mcp(full, 'tools/call', {
        name: 'create_rows',
        arguments: { tableId: leads.tableId, idempotencyKey: 'mcp-1', rows: [{ values: textValues(name, 'Dee') }] },
      });
      assert.equal(r.json.result.structuredContent.results[0].status, 'created', JSON.stringify(r.json));
    });
    await check('MCP read_file returns text', async () => {
      const r = await mcp(full, 'tools/call', { name: 'read_file', arguments: { fileId } });
      assert.equal(r.json.result.structuredContent.content, '# hello', JSON.stringify(r.json));
    });
    await check('MCP tool error is reported, not thrown', async () => {
      const r = await mcp(full, 'tools/call', {
        name: 'get_row',
        arguments: { tableId: leads.tableId, rowId: randomUUID() },
      });
      assert.equal(r.json.result.isError, true);
    });
    await check('MCP GET is 405 (stateless)', async () => {
      const r = await call('/v1/mcp', { token: full });
      expect(r, 405);
    });
    await check('MCP answers malformed JSON with a JSON-RPC parse error and refuses invalid base64', async () => {
      const response = await fetch(`${origin}/v1/mcp`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${full}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: '{"jsonrpc":',
      });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error.code, -32700);
      const r = await mcp(full, 'tools/call', {
        name: 'upload_file',
        arguments: { name: 'x.bin', mediaType: 'application/octet-stream', base64: '!!!', idempotencyKey: 'b64' },
      });
      assert.equal(r.json.result.isError, true);
    });
    await check('REST and MCP spend one per-token request budget', async () => {
      const limited = Fastify();
      const limiter = createTokenLimiter(2);
      limited.register(
        async v1 => {
          v1.register(async routes => registerPublicApi(routes, { tokens, api: externalApi, limiter }), {
            prefix: '/public',
          });
          registerPublicMcp(v1, { tokens, api: externalApi, limiter });
        },
        { prefix: '/v1' },
      );
      const base = await limited.listen({ host: '127.0.0.1', port: 0 });
      try {
        for (let i = 0; i < 2; i++)
          assert.equal(
            (await fetch(`${base}${pub}/agents`, { headers: { authorization: `Bearer ${full}` } })).status,
            200,
          );
        const response = await fetch(`${base}/v1/mcp`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${full}`,
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
        });
        assert.equal(response.status, 429);
        assert.ok(Number(response.headers.get('retry-after')) > 0);
        assert.equal((await response.json()).error.code, 'rate-limit-exceeded');
      } finally {
        await limited.close();
      }
    });
    await check('member removed from the workspace: their token stops working', async () => {
      const r = await call(`${ws}/access-tokens`, {
        method: 'POST',
        cookie: member.cookie,
        body: { name: 'm', scopes: ['tables:read'], expiry: '30d' },
      });
      expect(r, 201);
      const memberToken = r.json.token;
      expect(await call(`${pub}/tables`, { token: memberToken }), 200);
      await db.platform.query(`UPDATE ${s}.tf_memberships SET removed_at=now() WHERE id=$1`, [memberMembership]);
      expect(await call(`${pub}/tables`, { token: memberToken }), 401);
    });
    await check('revoke: token stops working at once', async () => {
      const list = await call(`${ws}/access-tokens`, { cookie: owner.cookie });
      const reader = list.json.tokens.find(t => t.name === 'Reader');
      expect(await call(`${ws}/access-tokens/${reader.id}`, { method: 'DELETE', cookie: owner.cookie }), 200);
      expect(await call(`${pub}/tables`, { token: readOnly }), 401);
    });
    await check('turning external access off stops every token', async () => {
      expect(
        await call(`${ws}/external-access`, { method: 'PUT', cookie: owner.cookie, body: { enabled: false } }),
        200,
      );
      expect(await call(`${pub}/tables`, { token: full }), 401);
    });

    await app.close();
    await pool.end();
    await object.close?.();
    await db.close();
  },
);
