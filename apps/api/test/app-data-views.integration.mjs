import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { AccessDenied } from '@tulipfarm/access';
import { appDataFixture } from './app-data-fixture.mjs';

test('members create, share, approve and revoke an app data view over HTTP', { timeout: 60000 }, async t => {
  const {
    db,
    service,
    workspace,
    schema,
    membership,
    adminMembership,
    members: { admin, lead, editor, reader, outsider },
    http,
    fields,
    definition,
    appId,
    live,
    build,
  } = await appDataFixture(t);

  const view = {
    requestId: '22222222-2222-4222-8222-222222222222',
    tableId: definition.id,
    fieldIds: [fields.title.id],
    predicate: { all: [{ fieldId: fields.owner.id, op: 'eq', operand: { kind: 'parameter', name: 'owner' } }] },
    actions: ['read'],
  };
  const views = `/${appId}/data-views`;

  await t.test('only signed-in members with the right access reach the routes', async () => {
    assert.equal((await http(null, 'GET', views)).status, 401);
    assert.equal((await http(null, 'POST', views, view)).status, 401);
    assert.deepEqual(await http(outsider, 'GET', views), { status: 404, body: { error: 'not-found' } });
    assert.equal((await http(reader, 'GET', views)).status, 403);
    assert.equal((await http(reader, 'POST', views, view)).status, 403);
    assert.deepEqual((await http(admin, 'GET', views)).body, { views: [] });
  });

  await t.test('creating a view checks its fields and the creator’s table rights', async () => {
    assert.equal((await http(editor, 'POST', views, view)).status, 404);
    const ranged = await http(lead, 'POST', views, {
      ...view,
      requestId: randomUUID(),
      predicate: { all: [{ fieldId: fields.secret.id, op: 'gt', operand: { kind: 'parameter', name: 'after' } }] },
    });
    assert.equal(ranged.status, 422);
    assert.equal(ranged.body.failure.code, 'definition-invalid');
    assert.deepEqual(ranged.body.issues, [
      { path: fields.secret.id, message: 'A parameter may only test a field the view does not list for equality' },
    ]);
    const file = await http(lead, 'POST', views, {
      ...view,
      requestId: randomUUID(),
      fieldIds: [fields.attachment.id],
    });
    assert.equal(file.status, 422);
    assert.equal(file.body.issues[0].path, fields.attachment.id);
    assert.equal(
      (await http(lead, 'POST', views, { ...view, requestId: randomUUID(), fieldIds: [randomUUID()] })).status,
      422,
    );
    assert.equal((await http(lead, 'POST', views, { ...view, fieldIds: [] })).status, 400);
    assert.deepEqual((await http(lead, 'GET', views)).body, { views: [] });
  });

  let viewId;
  await t.test('a repeated request returns the same view and a changed one is refused', async () => {
    const first = await http(lead, 'POST', views, view);
    assert.equal(first.status, 201);
    viewId = first.body.id;
    assert.deepEqual(
      { ...first.body, createdAt: typeof first.body.createdAt },
      {
        id: viewId,
        tableId: definition.id,
        fieldIds: view.fieldIds,
        predicate: view.predicate,
        actions: ['read'],
        createdBy: membership.lead,
        createdAt: 'string',
        sharedBy: null,
        sharedAt: null,
        approvedBy: null,
        approvedAt: null,
        blockers: ['not-approved'],
        table: { label: 'Posts', fields: [fields.title, fields.owner] },
      },
    );
    assert.deepEqual(await http(lead, 'POST', views, view), first);
    assert.deepEqual(
      (await http(editor, 'GET', views)).body.views[0].table,
      first.body.table,
      'an app editor without rights over the table still sees what the view uses',
    );
    assert.equal((await http(lead, 'POST', views, { ...view, actions: ['read', 'create'] })).status, 409);
  });

  const share = () => `${views}/${viewId}/share`;
  const approval = () => `${views}/${viewId}/approval`;
  const read = (releaseId = live) =>
    service.listThroughView(
      workspace.id,
      { kind: 'app', appId, releaseId },
      { viewId, parameters: { owner: 'ada' }, query: { limit: 10 } },
    );
  const hello = [{ [fields.title.id]: { kind: 'text', value: 'Hello' } }];
  const release = async number => {
    const id = randomUUID();
    await db.platform.query(
      `INSERT INTO ${schema}.tf_app_releases(id,app_id,number,build_id,commit,manifest_digest,published_by)
      VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [id, appId, number, build, 'c'.repeat(40), 'd'.repeat(64), membership.lead],
    );
    await db.platform.query(`UPDATE ${schema}.tf_apps SET live_release_id=$2 WHERE id=$1`, [appId, id]);
    return id;
  };

  let approvedAt;
  await t.test('a shared view serves the app only once an admin approves it', async () => {
    assert.equal((await http(reader, 'PUT', share())).status, 403);
    assert.equal((await http(editor, 'PUT', share())).status, 404, 'the sharer needs rights over the table');
    const shared = await http(lead, 'PUT', share());
    assert.equal(shared.status, 200);
    const { sharedAt, ...pending } = shared.body;
    assert.equal(typeof sharedAt, 'string');
    assert.deepEqual(
      { sharedBy: pending.sharedBy, approvedBy: pending.approvedBy, approvedAt: pending.approvedAt },
      { sharedBy: membership.lead, approvedBy: null, approvedAt: null },
    );
    assert.deepEqual(pending.blockers, ['not-approved']);
    await assert.rejects(read(), AccessDenied);
    assert.equal((await http(editor, 'PUT', approval())).status, 403);
    assert.equal((await http(lead, 'PUT', `${views}/${randomUUID()}/approval`)).status, 404);
    const approved = await http(admin, 'PUT', approval());
    assert.equal(approved.status, 200);
    assert.equal(approved.body.approvedBy, adminMembership);
    assert.deepEqual(approved.body.blockers, []);
    approvedAt = approved.body.approvedAt;
    assert.deepEqual(
      (await read()).records.map(record => record.values),
      hello,
    );
  });

  await t.test('approving again keeps the first decision', async () => {
    const again = await http(lead, 'PUT', approval());
    assert.equal(again.status, 200);
    assert.deepEqual(
      { approvedBy: again.body.approvedBy, approvedAt: again.body.approvedAt },
      { approvedBy: adminMembership, approvedAt },
    );
  });

  await t.test('an approval keeps serving after the sharer is demoted and the approver leaves', async () => {
    await db.platform.query(`UPDATE ${schema}.tf_memberships SET role='member' WHERE id=$1`, [membership.lead]);
    await db.platform.query(`UPDATE ${schema}.tf_memberships SET removed_at=now() WHERE id=$1`, [adminMembership]);
    const [listed] = (await http(editor, 'GET', views)).body.views;
    assert.deepEqual(
      { sharedBy: listed.sharedBy, approvedBy: listed.approvedBy, blockers: listed.blockers },
      { sharedBy: membership.lead, approvedBy: adminMembership, blockers: [] },
    );
    assert.deepEqual(
      (await read()).records.map(record => record.values),
      hello,
    );
    await db.platform.query(`UPDATE ${schema}.tf_memberships SET role='admin' WHERE id=$1`, [membership.lead]);
  });

  let second;
  await t.test('a newly published release is served without a new share', async () => {
    second = await release(2);
    assert.deepEqual(
      (await read(second)).records.map(record => record.values),
      hello,
    );
    await assert.rejects(read(live), AccessDenied, 'a host still on the earlier release is refused');
  });

  await t.test('an editor pause stops the app reading until it resumes', async () => {
    assert.equal((await http(editor, 'POST', `/${appId}/pause`, { requestId: randomUUID() })).status, 200);
    await assert.rejects(read(second), AccessDenied);
    assert.deepEqual((await http(lead, 'GET', views)).body.views[0].blockers, ['app-not-serving']);
    assert.equal((await http(editor, 'POST', `/${appId}/resume`, { requestId: randomUUID() })).status, 200);
    assert.deepEqual((await http(lead, 'GET', views)).body.views[0].blockers, []);
    assert.deepEqual(
      (await read(second)).records.map(record => record.values),
      hello,
    );
  });

  await t.test('revoking stops the next app request on every release', async () => {
    assert.equal((await http(reader, 'DELETE', share())).status, 403);
    assert.equal((await http(editor, 'DELETE', share())).status, 204);
    await assert.rejects(read(second), AccessDenied);
    assert.equal((await http(editor, 'DELETE', share())).status, 204);
    await db.platform.query(`UPDATE ${schema}.tf_apps SET live_release_id=$2 WHERE id=$1`, [appId, live]);
    await assert.rejects(read(live), AccessDenied, 'a rollback does not bring back revoked access');
    const [listed] = (await http(lead, 'GET', views)).body.views;
    assert.deepEqual(
      { sharedBy: listed.sharedBy, approvedBy: listed.approvedBy, blockers: listed.blockers },
      { sharedBy: null, approvedBy: null, blockers: ['not-approved'] },
    );
  });

  await t.test('a disabled app reports that it is not serving', async () => {
    await db.platform.query(`UPDATE ${schema}.tf_apps SET disabled_at=now() WHERE id=$1`, [appId]);
    assert.deepEqual((await http(lead, 'GET', views)).body.views[0].blockers, ['app-not-serving', 'not-approved']);
  });
});
