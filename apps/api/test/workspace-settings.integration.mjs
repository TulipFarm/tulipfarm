import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import Fastify from 'fastify';
import { Pool, escapeIdentifier, escapeLiteral } from 'pg';
import { createAuth } from '../src/auth.ts';
import { registerWorkspaceSettings } from '../src/workspace-settings.ts';
import {
  fixture,
  connect,
  denied,
  loadPlatformBaseline,
} from '../../../packages/workspace-storage/test/integration/fixture.mjs';
import { createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import {
  withMaintenanceTransaction,
  verifyWorkspaceIsolation,
  grantWorkspaceSettingsAuthority,
} from '../../../packages/workspace-storage/src/provisioning.ts';
import { createWorkspace, getWorkspace, listWorkspaces } from '@tulipfarm/workspaces/store';
import { registerGovernance } from '../src/governance.ts';
import { registerAgents } from '../src/agents.ts';
import { grantApplicationAccess } from '../../database/src/postgres.ts';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import { createEmailDeliveryStore, encryptEmailDelivery } from '../../../packages/workspaces/src/email-delivery.ts';

for (const commonVersion of [1, 25, 28]) {
  test(`workspace settings serialize live authority, recover receipts, and permanently fence deleted workspaces at common version ${commonVersion}`, async () => {
    const f = await fixture();
    const role = `settings_identity_${randomUUID().replaceAll('-', '')}`;
    const registryOwner = `settings_registry_${randomUUID().replaceAll('-', '')}`;
    let pool, runtime, app;
    try {
      await f.platform.query('DROP TABLE app.accounts; SET search_path TO app');
      await loadPlatformBaseline(f.platform);
      const password = randomUUID();
      await f.admin.query(`CREATE ROLE ${escapeIdentifier(role)} LOGIN PASSWORD ${escapeLiteral(password)}`);
      const url = new URL(f.connectionString);
      await f.platform.query(
        `GRANT CONNECT ON DATABASE ${escapeIdentifier(url.pathname.slice(1))} TO ${escapeIdentifier(role)}; GRANT USAGE ON SCHEMA app TO ${escapeIdentifier(role)}`,
      );
      await f.platform.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON app.users, app.accounts, app.sessions, app.verifications TO ${escapeIdentifier(role)}`,
      );
      url.username = role;
      url.password = password;
      pool = new Pool({ connectionString: url.href, options: '-c search_path=app' });
      const links = [];
      const auth = createAuth(
        pool,
        async ({ url }) => links.push(url),
        async () => {},
      );
      async function signIn(name) {
        await auth.api.signInMagicLink({
          headers: new Headers({ origin: 'http://localhost:5173' }),
          body: { email: `${randomUUID()}@example.com`, name },
        });
        const response = await auth.handler(new Request(links.pop()));
        const cookie = response.headers
          .getSetCookie()
          .map(value => value.split(';')[0])
          .join('; ');
        return { cookie, id: (await auth.api.getSession({ headers: new Headers({ cookie }) })).user.id };
      }
      const admin = await signIn('Administrator');
      const member = await signIn('Member');
      const stranger = await signIn('Stranger');
      const migrations = commonVersion === 1 ? f.baseline : (await workspaceTableMigrations()).slice(0, commonVersion);
      assert.equal(migrations.length, commonVersion);
      const compatibility = { minimum: commonVersion, maximum: commonVersion };
      const a = await f.create(migrations, { userId: admin.id });
      const b = await f.create(migrations, { userId: admin.id });
      const createId = randomUUID();
      for (const w of [a, b]) {
        await f.platform.query(
          `INSERT INTO app.workspaces(id, request_id, created_by, name, slug, soul_commit, soul_bucket, soul_key, ready_at) VALUES($1,$2,$3,$4,$5,$6,'retained','retained',now())`,
          [
            w.id,
            w === a ? createId : randomUUID(),
            admin.id,
            w === a ? 'Original name' : 'Other workspace',
            w === a ? 'original-url' : 'other-url',
            'a'.repeat(40),
          ],
        );
        await f.platform.query(
          `INSERT INTO app.workspace_storage(workspace_id, stage, runtime_credential,migration_credential,confirmation_credential) VALUES($1,'ready','{}','{}','{}')`,
          [w.id],
        );
      }
      await f.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
      await f.platform.query(
        `GRANT SELECT ON app.workspaces, app.workspace_storage, app.workspace_settings_commands TO ${escapeIdentifier(role)}; GRANT INSERT(request_id,created_by,name,slug) ON app.workspaces TO ${escapeIdentifier(role)}; GRANT INSERT(workspace_id) ON app.workspace_storage TO ${escapeIdentifier(role)}`,
      );
      const c = await f.create(migrations);
      for (const w of [a, b, c]) await verifyWorkspaceIsolation(f.platform, w.id);
      await f.admin.query(`CREATE ROLE ${escapeIdentifier(registryOwner)} NOLOGIN`);
      await f.databaseAdmin.query(
        `GRANT USAGE ON SCHEMA app TO ${escapeIdentifier(registryOwner)}; GRANT SELECT, UPDATE ON app.workspaces, app.workspace_storage TO ${escapeIdentifier(registryOwner)}; GRANT SELECT, INSERT ON app.workspace_settings_commands TO ${escapeIdentifier(registryOwner)}`,
      );
      await f.databaseAdmin.query(`GRANT SELECT, UPDATE ON app.email_deliveries TO ${escapeIdentifier(registryOwner)}`);
      await f.databaseAdmin.query(
        `ALTER FUNCTION app.workspace_access(uuid,boolean) OWNER TO ${escapeIdentifier(registryOwner)}; ALTER FUNCTION app.workspace_settings(uuid,uuid,uuid,jsonb) OWNER TO ${escapeIdentifier(registryOwner)}; ALTER FUNCTION app.model_availability_receipt() OWNER TO ${escapeIdentifier(registryOwner)}`,
      );
      assert.equal(
        (
          await f.databaseAdmin.query("SELECT has_schema_privilege($1,$2,'USAGE') AS allowed", [
            registryOwner,
            a.names.schema,
          ])
        ).rows[0].allowed,
        false,
      );
      for (const w of [a, b, c]) await grantWorkspaceSettingsAuthority(f.platform, w.id);
      assert.deepEqual(
        (
          await f.databaseAdmin.query(
            `SELECT has_table_privilege($1,$2,'SELECT') AS memberships,
      has_column_privilege($1,$3,'lock_version','UPDATE') AS lock,
      has_table_privilege($1,$2,'UPDATE') AS mutate_memberships,
      has_table_privilege($1,$4,'SELECT') AS audit`,
            [
              registryOwner,
              `"${a.names.schema}".tf_memberships`,
              `"${a.names.schema}".tf_authorization_lock`,
              `"${a.names.schema}".tf_audit_events`,
            ],
          )
        ).rows[0],
        { memberships: true, lock: true, mutate_memberships: false, audit: false },
      );
      const memberId = randomUUID();
      await f.platform.query(`INSERT INTO "${a.names.schema}".tf_memberships(id,user_id,role) VALUES($1,$2,'member')`, [
        memberId,
        member.id,
      ]);
      runtime = createWorkspaceRuntime({
        replicaCount: 1,
        reservedConnections: 2,
        databaseConnectionBudget: 40,
        connectionsPerPool: 4,
        resolveCredential: async id => ({
          workspaceId: id,
          generation: 1,
          connectionString: f.login(f.workspaces.find(w => w.id === id)),
        }),
      });
      const setup = await connect(f.connectionString);
      try {
        await setup.query('SELECT pg_advisory_lock(hashtextextended($1,739))', [b.id]);
        await setup.query("UPDATE app.workspace_storage SET stage='database' WHERE workspace_id=$1", [b.id]);
        assert.equal(await runtime.transaction(b.id, compatibility, async () => 'setup completed'), 'setup completed');
        await setup.query("UPDATE app.workspace_storage SET stage='ready' WHERE workspace_id=$1", [b.id]);
      } finally {
        await setup.end();
      }
      const store = { pool, runtime };
      app = Fastify({ ajv: { customOptions: { removeAdditional: false } } });
      app.register(
        async routes => {
          registerWorkspaceSettings(routes, { auth, ...store });
          registerGovernance(routes, { auth, identity: pool, runtime, compatibility });
          registerAgents(routes, { auth, pool, runtime, agentModel: null });
        },
        { prefix: '/v1' },
      );
      const address = await app.listen({ port: 0, host: '127.0.0.1' });
      const base = `/v1/workspaces/${a.id}/settings`;
      const http = async (who, method = 'GET', path = base, payload) => {
        const response = await fetch(`${address}${path}`, {
          method,
          headers: {
            cookie: who.cookie,
            origin: 'http://localhost:5173',
            ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
        });
        const body = await response.text();
        return { statusCode: response.status, body, json: () => JSON.parse(body) };
      };
      async function ok(who, method, path, payload) {
        const response = await http(who, method, path, payload);
        assert.equal(response.statusCode, 200, response.body);
        return response.json();
      }
      assert.equal((await app.inject(base)).statusCode, 401);
      assert.equal((await http(stranger)).statusCode, 404);
      assert.deepEqual(await ok(admin), {
        workspaceId: a.id,
        name: 'Original name',
        slug: 'original-url',
        revision: 0,
        canManage: true,
      });
      assert.equal((await ok(member)).canManage, false);
      const rename = { requestId: randomUUID(), expectedRevision: 0, name: 'Renamed workspace' };
      const direct = await connect(f.login(a));
      try {
        const sql = 'SELECT app.workspace_settings($1,$2,$3,$4) AS settings';
        for (const [actor, membership] of [
          [admin.id, randomUUID()],
          [stranger.id, a.membershipId],
          [member.id, a.membershipId],
        ]) {
          for (const command of [
            null,
            { ...rename, kind: 'rename' },
            {
              kind: 'delete',
              requestId: randomUUID(),
              expectedRevision: 0,
              confirmationName: 'Original name',
              acknowledgeRetainedData: true,
            },
          ]) {
            await assert.rejects(direct.query(sql, [a.id, actor, membership, command]), /workspace-settings-not-found/);
          }
        }
        assert.equal(
          (await direct.query(sql, [a.id, member.id, memberId, null])).rows[0].settings.name,
          'Original name',
        );
        for (const kind of ['rename', 'delete'])
          await assert.rejects(
            direct.query(sql, [a.id, member.id, memberId, { ...rename, kind }]),
            /workspace-settings-not-found/,
          );
        const removedId = randomUUID();
        await f.platform.query(
          `INSERT INTO "${a.names.schema}".tf_memberships(id,user_id,role,removed_at) VALUES($1,$2,'admin',now())`,
          [removedId, stranger.id],
        );
        for (const command of [null, { ...rename, kind: 'rename' }])
          await assert.rejects(
            direct.query(sql, [a.id, stranger.id, removedId, command]),
            /workspace-settings-not-found/,
          );
        await f.platform.query(`UPDATE "${a.names.schema}".tf_memberships SET removed_at=NULL WHERE id=$1`, [
          removedId,
        ]);
        const authorization = await connect(f.connectionString);
        try {
          await authorization.query('BEGIN');
          await authorization.query(`SELECT id FROM "${a.names.schema}".tf_authorization_lock WHERE id=1 FOR UPDATE`);
          const pending = assert.rejects(
            direct.query(sql, [a.id, stranger.id, removedId, { ...rename, kind: 'rename' }]),
            /workspace-settings-not-found/,
          );
          const pid = direct.processID;
          for (let attempt = 0; ; attempt++) {
            const waiting = await f.databaseAdmin.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1', [
              pid,
            ]);
            if (waiting.rows[0]?.wait_event_type === 'Lock') break;
            assert.ok(attempt < 100, 'Direct settings call must wait for the authorization lock');
            await setTimeout(10);
          }
          await authorization.query(`UPDATE "${a.names.schema}".tf_memberships SET removed_at=now() WHERE id=$1`, [
            removedId,
          ]);
          await authorization.query('COMMIT');
          await pending;
        } finally {
          await authorization.end();
        }
        await f.platform.query(`DELETE FROM "${a.names.schema}".tf_memberships WHERE id=$1`, [removedId]);
      } finally {
        await direct.end();
      }
      assert.equal((await http(member, 'PUT', `${base}/name`, rename)).statusCode, 404);
      assert.equal((await http(admin, 'PUT', `${base}/name`, { ...rename, name: '  ' })).statusCode, 400);
      const receipt = { requestId: rename.requestId, name: 'Renamed workspace', revision: 1 };
      assert.deepEqual(await ok(admin, 'PUT', `${base}/name`, rename), receipt);
      assert.deepEqual(await ok(admin, 'PUT', `${base}/name`, rename), receipt);
      assert.equal((await http(admin, 'PUT', `${base}/name`, { ...rename, name: 'Changed replay' })).statusCode, 409);
      assert.equal((await http(admin, 'PUT', `${base}/name`, { ...rename, requestId: randomUUID() })).statusCode, 409);
      assert.equal(
        (await createWorkspace(store, admin.id, { requestId: createId, name: 'Original name', slug: 'original-url' }))
          .name,
        'Renamed workspace',
      );
      assert.equal((await getWorkspace(store, admin.id, 'original-url')).name, 'Renamed workspace');
      const recovery = `/v1/workspace-settings/${a.id}/commands/${rename.requestId}`;
      const availabilityBase = `/v1/workspaces/${a.id}/model-policy/availability`;
      const availabilityCommand = {
        requestId: randomUUID(),
        familyId: 'claude-opus',
        enabled: false,
        expectedRevision: 0,
      };
      const availabilityReceipt = {
        requestId: availabilityCommand.requestId,
        familyId: 'claude-opus',
        enabled: false,
        revision: 1,
      };
      const availabilityRecovery = `/v1/workspace-settings/${a.id}/model-availability/commands/${availabilityCommand.requestId}`;
      if (commonVersion === 25) {
        assert.deepEqual(await ok(admin, 'PUT', availabilityBase, availabilityCommand), availabilityReceipt);
        assert.deepEqual(await ok(admin, 'GET', availabilityRecovery), availabilityReceipt);
        assert.equal((await app.inject(availabilityRecovery)).statusCode, 401);
        assert.equal((await http(member, 'GET', availabilityRecovery)).statusCode, 404);
        assert.equal((await http(admin, 'GET', availabilityRecovery.replace(a.id, b.id))).statusCode, 404);
        assert.equal(
          (await http(admin, 'GET', availabilityRecovery.replace(availabilityCommand.requestId, randomUUID())))
            .statusCode,
          404,
        );
        assert.equal(
          (await http(admin, 'GET', availabilityRecovery.replace(availabilityCommand.requestId, rename.requestId)))
            .statusCode,
          404,
        );
        assert.equal(
          (await http(admin, 'GET', recovery.replace(rename.requestId, availabilityCommand.requestId))).statusCode,
          404,
        );
        assert.deepEqual(
          (
            await f.platform.query(
              'SELECT user_id,membership_id,receipt FROM app.workspace_settings_commands WHERE workspace_id=$1 AND request_id=$2',
              [a.id, availabilityCommand.requestId],
            )
          ).rows,
          [{ user_id: admin.id, membership_id: a.membershipId, receipt: availabilityReceipt }],
        );
        const failedCommand = { requestId: randomUUID(), familyId: 'gpt-astra', enabled: false, expectedRevision: 0 };
        await f.databaseAdmin.query(
          `REVOKE INSERT ON app.workspace_settings_commands FROM ${escapeIdentifier(registryOwner)}`,
        );
        assert.equal((await http(admin, 'PUT', availabilityBase, failedCommand)).statusCode, 503);
        assert.equal(
          (
            await http(
              admin,
              'GET',
              availabilityRecovery.replace(availabilityCommand.requestId, failedCommand.requestId),
            )
          ).statusCode,
          404,
        );
        assert.equal(
          (
            await f.platform.query(
              `SELECT count(*)::int AS count FROM "${a.names.schema}".tf_model_availability_commands WHERE request_id=$1`,
              [failedCommand.requestId],
            )
          ).rows[0].count,
          0,
        );
        assert.deepEqual(
          (await ok(admin, 'GET', availabilityBase)).items.find(row => row.familyId === 'gpt-astra'),
          { familyId: 'gpt-astra', enabled: true, revision: 0 },
        );
        await f.databaseAdmin.query(
          `GRANT INSERT ON app.workspace_settings_commands TO ${escapeIdentifier(registryOwner)}`,
        );
      }
      assert.deepEqual(await ok(admin, 'GET', recovery), { kind: 'rename', ...receipt });
      assert.equal((await http(member, 'GET', recovery)).statusCode, 404);
      const auditBefore = (
        await f.platform.query(
          `SELECT actor_id,operation,subject_id FROM "${a.names.schema}".tf_audit_events WHERE id=$1`,
          [rename.requestId],
        )
      ).rows;
      assert.deepEqual(auditBefore, [{ actor_id: a.membershipId, operation: 'workspace.rename', subject_id: a.id }]);
      await f.platform.query(`UPDATE "${a.names.schema}".tf_memberships SET removed_at=now() WHERE id=$1`, [
        a.membershipId,
      ]);
      if (commonVersion === 25) {
        assert.deepEqual(await ok(admin, 'GET', availabilityRecovery), availabilityReceipt);
        assert.equal((await http(admin, 'GET', availabilityBase)).statusCode, 404);
        assert.equal((await http(admin, 'PUT', availabilityBase, availabilityCommand)).statusCode, 404);
      }
      assert.deepEqual(await ok(admin, 'GET', recovery), { kind: 'rename', ...receipt });
      assert.equal((await http(admin, 'PUT', `${base}/name`, rename)).statusCode, 404);
      const rejoinedId = randomUUID();
      await f.platform.query(`INSERT INTO "${a.names.schema}".tf_memberships(id,user_id,role) VALUES($1,$2,'admin')`, [
        rejoinedId,
        admin.id,
      ]);
      if (commonVersion === 25) {
        await f.platform.query(`UPDATE "${a.names.schema}".tf_memberships SET role='member' WHERE id=$1`, [rejoinedId]);
        assert.deepEqual(await ok(admin, 'GET', availabilityRecovery), availabilityReceipt);
        assert.equal((await http(admin, 'PUT', availabilityBase, availabilityCommand)).statusCode, 404);
        assert.equal(
          (await http(admin, 'GET', `${availabilityBase}/commands/${availabilityCommand.requestId}`)).statusCode,
          404,
        );
        await f.platform.query(`UPDATE "${a.names.schema}".tf_memberships SET role='admin' WHERE id=$1`, [rejoinedId]);
      }
      assert.deepEqual(await ok(admin, 'PUT', `${base}/name`, rename), receipt);
      assert.deepEqual(
        (
          await f.platform.query(
            `SELECT actor_id,operation,subject_id FROM "${a.names.schema}".tf_audit_events WHERE id=$1`,
            [rename.requestId],
          )
        ).rows,
        auditBefore,
      );
      assert.equal(
        (
          await f.platform.query(
            'SELECT membership_id FROM app.workspace_settings_commands WHERE workspace_id=$1 AND request_id=$2',
            [a.id, rename.requestId],
          )
        ).rows[0].membership_id,
        a.membershipId,
      );

      const races = await Promise.all(
        ['First', 'Second'].map(name =>
          http(admin, 'PUT', `${base}/name`, { requestId: randomUUID(), expectedRevision: 1, name }),
        ),
      );
      assert.deepEqual(races.map(r => r.statusCode).sort(), [200, 409]);
      const currentName = races.find(r => r.statusCode === 200).json().name;
      await f.platform.query(`UPDATE "${a.names.schema}".tf_memberships SET role='admin' WHERE id=$1`, [memberId]);
      const blocker = await connect(f.connectionString);
      try {
        await blocker.query('BEGIN');
        await blocker.query(`SELECT id FROM "${a.names.schema}".tf_authorization_lock WHERE id=1 FOR UPDATE`);
        const pending = http(member, 'PUT', `${base}/name`, {
          requestId: randomUUID(),
          expectedRevision: 2,
          name: 'Must not commit',
        });
        await setTimeout(50);
        await blocker.query(`UPDATE "${a.names.schema}".tf_memberships SET removed_at=now() WHERE id=$1`, [memberId]);
        await blocker.query('COMMIT');
        assert.equal((await pending).statusCode, 404);
      } finally {
        await blocker.end();
      }
      assert.equal((await http(member)).statusCode, 404);
      const deletion = {
        requestId: randomUUID(),
        expectedRevision: 2,
        confirmationName: currentName,
        acknowledgeRetainedData: true,
      };
      const deliveryId = randomUUID();
      await f.platform.query(
        "INSERT INTO app.email_deliveries(id,kind,workspace_id,invitation_id,payload,expires_at) VALUES($1,'invitation',$2,$1,'{}',now()+interval '1 day')",
        [deliveryId, a.id],
      );
      const keys = { keyId: 'test', key: Buffer.alloc(32, 1), previous: new Map() };
      const deliveries = createEmailDeliveryStore(f.platform, keys);
      const heldId = randomUUID(),
        expiredId = randomUUID();
      for (const id of [heldId, expiredId])
        await f.platform.query(
          "INSERT INTO app.email_deliveries(id,kind,workspace_id,invitation_id,payload,expires_at) VALUES($1,'invitation',$2,$1,$3,now()+interval '1 day')",
          [
            id,
            a.id,
            encryptEmailDelivery(
              id,
              { kind: 'invitation', email: 'invitee@example.com', url: 'https://example.com/invite' },
              keys,
            ),
          ],
        );
      await f.platform.query(
        "UPDATE app.email_deliveries SET status='sending', attempts=1, lease_until=now()-interval '1 minute' WHERE id=$1",
        [expiredId],
      );
      let failSend, sendEntered;
      const sending = new Promise(resolve => {
        sendEntered = resolve;
      });
      const provider = new Promise((_resolve, reject) => {
        failSend = reject;
      });
      const held = assert.rejects(
        deliveries.deliver(heldId, async () => {
          sendEntered();
          await provider;
        }),
        /Email delivery failed/,
      );
      await sending;
      assert.equal(
        (await http(admin, 'POST', `${base}/delete`, { ...deletion, acknowledgeRetainedData: false })).statusCode,
        400,
      );
      assert.equal(
        (await http(admin, 'POST', `${base}/delete`, { ...deletion, confirmationName: 'Wrong' })).statusCode,
        409,
      );
      assert.equal((await http(admin, 'POST', `${base}/delete`, { ...deletion, expectedRevision: 0 })).statusCode, 409);
      const restricted = await connect(f.login(a));
      try {
        await denied(restricted, 'UPDATE app.workspaces SET name=$1 WHERE id=$2', ['No', a.id]);
        await denied(restricted, 'SELECT * FROM app.workspace_settings_commands');
        await denied(restricted, "UPDATE app.workspace_settings_commands SET receipt='{}'");
        await denied(restricted, 'DELETE FROM app.workspace_settings_commands');
        await denied(
          restricted,
          'INSERT INTO app.workspace_settings_commands SELECT * FROM app.workspace_settings_commands',
        );
        await denied(restricted, 'SELECT app.model_availability_receipt()');
        await denied(pool, "UPDATE app.workspace_settings_commands SET receipt='{}'");
        await denied(pool, 'DELETE FROM app.workspace_settings_commands');
        await denied(pool, 'INSERT INTO app.workspace_settings_commands SELECT * FROM app.workspace_settings_commands');
        if (commonVersion === 25) {
          const forged = { ...availabilityCommand, requestId: randomUUID() };
          const insert = `INSERT INTO "${a.names.schema}".tf_model_availability_commands(membership_id,request_id,input,receipt) VALUES($1,$2,$3,$4)`;
          await denied(restricted, insert, [
            a.membershipId,
            forged.requestId,
            forged,
            { ...availabilityReceipt, requestId: forged.requestId },
          ]);
          await denied(restricted, insert, [
            memberId,
            forged.requestId,
            forged,
            { ...availabilityReceipt, requestId: forged.requestId },
          ]);
          await assert.rejects(
            restricted.query(insert, [
              rejoinedId,
              forged.requestId,
              forged,
              { ...availabilityReceipt, requestId: forged.requestId, enabled: true },
            ]),
            error => error.code === '22023',
          );
          assert.equal(
            (
              await f.platform.query(
                'SELECT count(*)::int AS count FROM app.workspace_settings_commands WHERE request_id=$1',
                [forged.requestId],
              )
            ).rows[0].count,
            0,
          );
        }
        await denied(restricted, `UPDATE "${a.names.schema}".tf_audit_events SET operation='forged'`);
        await denied(restricted, `DELETE FROM "${a.names.schema}".tf_audit_events`);
        await denied(restricted, 'SELECT app.workspace_settings($1,$2,$3,NULL)', [b.id, admin.id, a.membershipId]);
      } finally {
        await restricted.end();
      }

      let releaseRead;
      let readEntered;
      const entered = new Promise(resolve => {
        readEntered = resolve;
      });
      const release = new Promise(resolve => {
        releaseRead = resolve;
      });
      const inFlight = runtime.transaction(a.id, compatibility, async ({ client }) => {
        readEntered();
        await release;
        return (await client.query(`SELECT count(*)::int AS count FROM "${a.names.schema}".tf_memberships`)).rows[0]
          .count;
      });
      await entered;
      const deletes = [
        http(admin, 'POST', `${base}/delete`, deletion),
        http(admin, 'POST', `${base}/delete`, deletion),
      ];
      await setTimeout(50);
      assert.equal(
        (await f.platform.query('SELECT stage FROM app.workspace_storage WHERE workspace_id=$1', [a.id])).rows[0].stage,
        'ready',
      );
      releaseRead();
      assert.equal(await inFlight, 3);
      const deleted = {
        requestId: deletion.requestId,
        workspaceId: a.id,
        status: 'deleted',
        dataDisposition: 'retained',
      };
      for (const response of await Promise.all(deletes)) {
        assert.equal(response.statusCode, 200, response.body);
        assert.deepEqual(response.json(), deleted);
      }
      failSend(new Error('Provider failed after deletion'));
      await held;
      for (const id of [heldId, expiredId]) {
        await deliveries.deliver(id, async () => assert.fail('Deleted workspace delivery retried'));
        assert.deepEqual(
          (
            await f.platform.query('SELECT status,payload,lease_until,attempts FROM app.email_deliveries WHERE id=$1', [
              id,
            ])
          ).rows[0],
          { status: 'cancelled', payload: null, lease_until: null, attempts: 1 },
        );
      }
      assert.deepEqual(await deliveries.pending(), []);
      assert.deepEqual(await ok(admin, 'POST', `${base}/delete`, deletion), deleted);
      assert.equal(
        (await http(admin, 'POST', `${base}/delete`, { ...deletion, confirmationName: 'Changed' })).statusCode,
        409,
      );
      assert.deepEqual(await ok(admin, 'GET', `/v1/workspace-settings/${a.id}/commands/${deletion.requestId}`), {
        kind: 'delete',
        ...deleted,
      });
      assert.equal(
        (await http(stranger, 'GET', `/v1/workspace-settings/${a.id}/commands/${deletion.requestId}`)).statusCode,
        404,
      );
      assert.equal((await http(admin)).statusCode, 404);
      if (commonVersion === 25) {
        assert.deepEqual(await ok(admin, 'GET', availabilityRecovery), availabilityReceipt);
        assert.equal((await http(stranger, 'GET', availabilityRecovery)).statusCode, 404);
        assert.equal((await http(admin, 'GET', availabilityBase)).statusCode, 404);
        assert.equal((await http(admin, 'PUT', availabilityBase, availabilityCommand)).statusCode, 404);
      }
      assert.deepEqual(
        (await f.platform.query('SELECT status,payload FROM app.email_deliveries WHERE id=$1', [deliveryId])).rows[0],
        { status: 'cancelled', payload: null },
      );
      assert.equal((await http(admin, 'GET', `/v1/workspaces/${a.id}/governance/me`)).statusCode, 404);
      await assert.rejects(
        runtime.transaction(a.id, compatibility, async () => 'stale cached credentials'),
        error => error.code === 'disabled',
      );
      await assert.rejects(
        withMaintenanceTransaction({
          connectionString: f.login(a, 'migration'),
          workspaceId: a.id,
          capability: 'migration',
          operation: async () => 'stale migration credentials',
        }),
        error => error.code === 'disabled',
      );
      assert.equal(await getWorkspace(store, admin.id, 'original-url'), null);
      assert.deepEqual(
        (await listWorkspaces(store, admin.id)).map(w => w.id),
        [b.id],
      );
      assert.equal((await ok(admin, 'GET', `/v1/workspaces/${b.id}/settings`)).name, 'Other workspace');
      assert.equal(
        (await f.platform.query(`SELECT count(*)::int AS count FROM "${a.names.schema}".tf_memberships`)).rows[0].count,
        3,
      );
      assert.equal((await auth.api.getSession({ headers: new Headers({ cookie: admin.cookie }) })).user.id, admin.id);
      await assert.rejects(
        createWorkspace(store, admin.id, { requestId: createId, name: 'Original name', slug: 'original-url' }),
        /Workspace not found/,
      );
      await assert.rejects(
        f.platform.query("UPDATE app.workspace_storage SET stage='ready' WHERE workspace_id=$1", [a.id]),
        /tombstones are permanent/,
      );
      await grantApplicationAccess(f.platform, 'isolated-v1');
    } finally {
      await app?.close();
      await runtime?.close();
      await pool?.end();
      await f.close();
      const cleanup = await connect(process.env.TEST_ADMIN_DATABASE_URL);
      try {
        await cleanup.query(`DROP ROLE IF EXISTS ${escapeIdentifier(role)}, ${escapeIdentifier(registryOwner)}`);
      } finally {
        await cleanup.end();
      }
    }
  });
}
