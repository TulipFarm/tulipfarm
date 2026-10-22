import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { AccessDenied } from '@tulipfarm/access';
import { withMaintenanceTransaction } from '@tulipfarm/workspace-storage/provisioning';
import { createGoogleWorkspaceService } from '../src/service.ts';
import { createGoogleOperations } from '../src/operations.ts';
import { createGoogleApproval } from '../src/operation-approval.ts';
import { googleFixture } from './fixture.mjs';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';

const write = { kind: 'docs.documents.create', title: 'Exact approved title' };
const read = { kind: 'docs.documents.get', documentId: 'document-1' };
const executing = { status: 'executing', result: null, error: null };
const uncertain = { status: 'outcome-unknown', result: null, error: 'provider-outcome-unknown' };
const compatibility = commonCompatibility;
async function fixture() {
  const f = await googleFixture();
  const calls = [];
  let provider = async () => Response.json({ documentId: 'document-1', title: write.title });
  const fetcher = async (url, init) => {
    calls.push({ url: String(url), init });
    return provider(url, init);
  };
  const make = (overrides = {}) =>
    createGoogleOperations({ runtime: f.runtime, integrations: f.service, fetcher, ...overrides });
  const operations = make();
  const approve = createGoogleApproval({
    runtime: f.runtime,
    resolveConfirmationCredential: async () => f.db.login(f.workspace, 'confirmation'),
  });
  const propose = (operation = write, commandId = randomUUID()) =>
    operations.propose(f.workspace.id, f.member.userId, { operation, commandId });
  const decide = (proposal, decision = 'approve') =>
    approve(f.workspace.id, f.member.userId, proposal.id, { digest: proposal.digest, decision });
  const execute = proposal => operations.execute(f.workspace.id, f.member.userId, proposal.id);
  return {
    ...f,
    calls,
    make,
    operations,
    approve,
    propose,
    decide,
    execute,
    provider(value) {
      provider = value;
    },
  };
}

test('Google operations select only the trusted human integration and protect exact approval', async () => {
  const f = await fixture();
  const w = f.workspace.id,
    u = f.member.userId;
  try {
    await assert.rejects(f.operations.read(w, u, { operation: read }), /integration-required/);
    await assert.rejects(f.propose(), /integration-required/);
    const connected = await f.connect();
    assert.deepEqual(await f.operations.read(w, u, { operation: read }), {
      untrusted: true,
      data: { documentId: 'document-1', title: write.title },
    });
    const expectedIntegration = {
      integrationId: connected.integrationId,
      accountId: connected.accountId,
      generation: connected.generation,
      scopes: connected.scopes,
    };
    assert.deepEqual(await f.operations.read(w, u, { operation: read, expectedIntegration }), {
      untrusted: true,
      data: { documentId: 'document-1', title: write.title },
    });
    const reads = f.calls.length;
    for (const change of [
      { generation: connected.generation + 1 },
      { accountId: 'other-account' },
      { integrationId: randomUUID() },
    ])
      await assert.rejects(
        f.operations.read(w, u, { operation: read, expectedIntegration: { ...expectedIntegration, ...change } }),
        /reconnect-required/,
      );
    assert.equal(f.calls.length, reads);
    await assert.rejects(f.operations.read(w, f.admin.userId, { operation: read }), /integration-required/);
    await assert.rejects(f.operations.read(w, u, { operation: read, integrationId: connected.integrationId }));
    await assert.rejects(f.operations.read(w, u, { operation: write }), /operation-read-required/);
    await assert.rejects(f.propose(read), /operation-write-required/);
    const commandId = randomUUID();
    const proposal = await f.propose(write, commandId);
    assert.equal(proposal.integration.integrationId, connected.integrationId);
    assert.deepEqual(proposal.integration.requiredScopes, ['https://www.googleapis.com/auth/documents']);
    assert.deepEqual(await f.propose(write, commandId), proposal);
    await assert.rejects(f.propose({ ...write, title: 'Changed' }, commandId), /operation-conflict/);
    await assert.rejects(f.execute(proposal), /operation-approval-required/);
    await assert.rejects(
      f.approve(w, u, proposal.id, { digest: 'a'.repeat(64), decision: 'approve' }),
      /operation-conflict/,
    );
    for (const method of [
      () => f.operations.proposal(w, f.admin.userId, proposal.id),
      () => f.operations.execute(w, f.admin.userId, proposal.id),
      () => f.approve(w, f.admin.userId, proposal.id, { digest: proposal.digest, decision: 'approve' }),
    ])
      await assert.rejects(method(), AccessDenied);
    for (const sql of [
      `INSERT INTO ${f.table('tf_google_decisions')} (proposal_id,membership_id,digest,decision) VALUES ('${proposal.id}','${f.member.membershipId}','${proposal.digest}','approve')`,
      `UPDATE ${f.table('tf_google_proposals')} SET operation='{}'`,
      `UPDATE ${f.table('tf_google_proposals')} SET expires_at=clock_timestamp()+interval '1 day'`,
      `UPDATE ${f.table('tf_google_decisions')} SET decision='approve'`,
      `DELETE FROM ${f.table('tf_google_receipts')}`,
    ])
      await assert.rejects(
        f.runtime.transaction(w, compatibility, tx => tx.client.query(sql)),
        error => error.code === '42501',
      );
    assert.equal((await f.decide(proposal)).decision, 'approve');
    await assert.rejects(
      withMaintenanceTransaction({
        connectionString: f.db.login(f.workspace, 'confirmation'),
        workspaceId: w,
        capability: 'confirmation',
        operation: tx => tx.client.query(`SELECT credential FROM ${f.table('tf_google_integrations')}`),
      }),
      error => error.code === '42501',
    );
    assert.equal((await f.execute(proposal)).status, 'succeeded');
    assert.deepEqual(JSON.parse(f.calls.at(-1).init.body), { title: write.title });
    assert.equal(f.calls.at(-1).init.headers.authorization, 'Bearer initial-private-access');
    await assert.rejects(
      f.runtime.transaction(w, compatibility, tx =>
        tx.client.query(
          `UPDATE ${f.table('tf_google_receipts')} SET status='executing',result=NULL WHERE proposal_id=$1`,
          [proposal.id],
        ),
      ),
      /Receipt is terminal/,
    );
  } finally {
    await f.close();
  }
});

test('Meet creation is flagged, bound to the exact proposal and never repeated', async () => {
  const f = await fixture();
  try {
    await f.connect();
    let enabled = false;
    const operations = f.make({
      calendarFeaturesEnabled: async (workspaceId, userId) => {
        assert.equal(workspaceId, f.workspace.id);
        assert.equal(userId, f.member.userId);
        return enabled;
      },
    });
    const commandId = randomUUID();
    const operation = {
      kind: 'calendar.events.create',
      calendarId: 'primary',
      event: {
        summary: 'Planning',
        start: { date: '2026-10-12' },
        end: { date: '2026-10-13' },
        conferenceData: { createRequest: { conferenceSolutionKey: { type: 'hangoutsMeet' } } },
      },
    };
    const propose = () => operations.propose(f.workspace.id, f.member.userId, { commandId, operation });
    await assert.rejects(propose(), /calendar-feature-disabled/);
    assert.equal(f.calls.length, 0);
    enabled = true;
    const proposal = await propose();
    assert.equal(proposal.operation.event.conferenceData.createRequest.requestId, commandId);
    assert.deepEqual(await propose(), proposal);
    await assert.rejects(
      operations.execute(f.workspace.id, f.member.userId, proposal.id),
      /operation-approval-required/,
    );
    await f.decide(proposal);
    enabled = false;
    await assert.rejects(operations.execute(f.workspace.id, f.member.userId, proposal.id), /calendar-feature-disabled/);
    assert.equal(f.calls.length, 0);
    enabled = true;
    f.provider(async () =>
      Response.json({
        ...proposal.operation.event,
        id: 'event-1',
        conferenceData: { createRequest: { status: { statusCode: 'pending' } } },
      }),
    );
    const receipt = await operations.execute(f.workspace.id, f.member.userId, proposal.id);
    assert.equal(receipt.status, 'succeeded');
    assert.equal(new URL(f.calls[0].url).searchParams.get('conferenceDataVersion'), '1');
    assert.equal(JSON.parse(f.calls[0].init.body).conferenceData.createRequest.requestId, commandId);
    enabled = false;
    assert.deepEqual(await operations.execute(f.workspace.id, f.member.userId, proposal.id), receipt);
    assert.equal(f.calls.length, 1);
  } finally {
    await f.close();
  }
});

test('committed receipt is visible before network and concurrent/restarted executors dispatch once', async () => {
  const f = await fixture();
  try {
    await f.connect();
    const proposal = await f.propose();
    await f.decide(proposal);
    const entered = Promise.withResolvers(),
      release = Promise.withResolvers();
    f.provider(async () => {
      const rows = (
        await f.db.platform.query(
          `SELECT status,result,error FROM ${f.table('tf_google_receipts')} WHERE proposal_id=$1`,
          [proposal.id],
        )
      ).rows;
      assert.deepEqual(rows, [executing]);
      entered.resolve();
      await release.promise;
      return Response.json({ documentId: 'document-1' });
    });
    const pending = f.execute(proposal);
    await entered.promise;
    try {
      assert.deepEqual(await f.make().execute(f.workspace.id, f.member.userId, proposal.id), executing);
    } finally {
      release.resolve();
    }
    const result = await pending;
    assert.deepEqual(result, {
      status: 'succeeded',
      result: { untrusted: true, data: { documentId: 'document-1' } },
      error: null,
    });
    assert.deepEqual(await f.make().execute(f.workspace.id, f.member.userId, proposal.id), result);
    assert.equal(f.calls.length, 1);
    const concurrent = await f.propose();
    await f.decide(concurrent);
    f.provider(async () => Response.json({ documentId: 'document-2' }));
    const results = await Promise.all(
      Array.from({ length: 8 }, () => f.make().execute(f.workspace.id, f.member.userId, concurrent.id)),
    );
    assert.equal(results.filter(value => value.status === 'succeeded').length >= 1, true);
    assert.equal(f.calls.length, 2);
  } finally {
    await f.close();
  }
});

test('scope, account, generation, expiry and rejection fences deny dispatch', async () => {
  const f = await fixture();
  try {
    const status = await f.connect();
    const rejected = await f.propose();
    await f.decide(rejected, 'reject');
    await assert.rejects(f.decide(rejected), /operation-conflict/);
    await assert.rejects(f.execute(rejected), /operation-approval-required/);
    const expired = await f.propose();
    await f.decide(expired);
    await f.db.platform.query(
      `UPDATE ${f.table('tf_google_proposals')} SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`,
      [expired.id],
    );
    await assert.rejects(f.execute(expired), /operation-expired/);
    for (const [column, value, error] of [
      ['generation', status.generation + 1, /operation-conflict/],
      ['account_id', 'replacement-account', /operation-conflict/],
      ['scopes', ['openid'], /insufficient-scope/],
    ]) {
      const proposal = await f.propose();
      await f.decide(proposal);
      await f.db.platform.query(`UPDATE ${f.table('tf_google_integrations')} SET ${column}=$1`, [value]);
      await assert.rejects(f.execute(proposal), error);
      await assert.rejects(f.decide(proposal), error);
      await f.db.platform.query(
        `UPDATE ${f.table('tf_google_integrations')} SET generation=$1,account_id=$2,scopes=$3`,
        [status.generation, status.accountId, status.scopes],
      );
    }
    const pending = await f.propose();
    await f.decide(pending);
    await f.db.platform.query(
      `UPDATE ${f.table('tf_google_integrations')} SET scopes=array_append(scopes,'extra-scope')`,
    );
    await f.begin();
    assert.equal((await f.execute(pending)).status, 'succeeded');
    assert.equal(f.calls.length, 1);
    assert.equal((await f.operations.proposal(f.workspace.id, f.member.userId, rejected.id)).decision, 'reject');
  } finally {
    await f.close();
  }
});

test('provider uncertainty and abandoned executing receipts never replay', async () => {
  const f = await fixture();
  try {
    await f.connect();
    const proposal = await f.propose();
    await f.decide(proposal);
    f.provider(async () => {
      throw new Error('private transport failure');
    });
    assert.deepEqual(await f.execute(proposal), uncertain);
    assert.deepEqual(await f.make().execute(f.workspace.id, f.member.userId, proposal.id), uncertain);
    const abandoned = await f.propose();
    await f.decide(abandoned);
    await f.runtime.transaction(f.workspace.id, compatibility, tx =>
      tx.client.query(`INSERT INTO ${f.table('tf_google_receipts')} (proposal_id) VALUES ($1)`, [abandoned.id]),
    );
    assert.deepEqual(await f.make().execute(f.workspace.id, f.member.userId, abandoned.id), executing);
    assert.equal(f.calls.length, 1);
    const denied = await f.propose();
    await f.decide(denied);
    f.provider(async () => new Response(null, { status: 403 }));
    const failed = { status: 'failed', result: null, error: 'provider-request-failed' };
    assert.deepEqual(await f.execute(denied), failed);
    assert.deepEqual(await f.make().execute(f.workspace.id, f.member.userId, denied.id), failed);
    assert.equal(f.calls.length, 2);
  } finally {
    await f.close();
  }
});

test('integration changes after claim fence the provider write, while added refresh scopes keep it', async () => {
  const f = await fixture();
  try {
    const status = await f.connect();
    const proposal = await f.propose();
    await f.decide(proposal);
    const delayed = {
      ...f.service,
      async withCredential(fence, operation) {
        await f.db.platform.query(`UPDATE ${f.table('tf_google_integrations')} SET generation=generation+1`);
        return f.service.withCredential(fence, operation);
      },
    };
    assert.deepEqual(
      await f.make({ integrations: delayed }).execute(f.workspace.id, f.member.userId, proposal.id),
      uncertain,
    );
    await f.db.platform.query(`UPDATE ${f.table('tf_google_integrations')} SET generation=$1`, [status.generation]);
    const refreshed = await f.propose();
    await f.decide(refreshed);
    f.advance(3600000);
    f.behavior({ scopes: [...status.scopes, 'extra-refresh-scope'] });
    assert.equal((await f.execute(refreshed)).status, 'succeeded');
    assert.equal(f.calls.length, 1);
    assert.equal(
      (await f.service.status(f.workspace.id, f.member.userId)).scopes.includes('extra-refresh-scope'),
      true,
    );
  } finally {
    await f.close();
  }
});

test('provider credential reflections never enter persisted outcomes', async () => {
  const f = await fixture();
  try {
    await f.connect();
    const proposal = await f.propose();
    await f.decide(proposal);
    const reflected = Buffer.from('initial-private-access').toString('base64');
    f.provider(async () => Response.json({ nested: [{ [reflected]: 'hidden in a key' }] }));
    assert.deepEqual(await f.execute(proposal), uncertain);
    await assert.rejects(f.operations.read(f.workspace.id, f.member.userId, { operation: read }));
    const rows = (await f.db.platform.query(`SELECT * FROM ${f.table('tf_google_receipts')}`)).rows;
    assert.deepEqual(
      rows.map(({ status, result, error }) => ({ status, result, error })),
      [uncertain],
    );
    assert.equal(JSON.stringify(rows).includes(reflected), false);
  } finally {
    await f.close();
  }
});

// #509 commits `succeeded` inside the credential transaction, so only a credential rollback leaves the outcome unknown.
test('provider success followed by credential rollback is outcome-unknown, while a later result transaction failure keeps the committed success', async () => {
  const f = await fixture();
  try {
    await f.connect();
    for (const failure of ['credential', 'result']) {
      const proposal = await f.propose();
      await f.decide(proposal);
      let wrote = false;
      f.provider(async () => {
        wrote = true;
        return Response.json({ documentId: 'applied' });
      });
      const failing = {
        transaction: (workspaceId, compatibility, operation) =>
          f.runtime.transaction(workspaceId, compatibility, async tx => {
            const result = await operation(tx);
            if (wrote) {
              await tx.client.query('SELECT 1/0');
            }
            return result;
          }),
      };
      const options =
        failure === 'credential'
          ? { integrations: createGoogleWorkspaceService({ ...f.serviceOptions, runtime: failing }) }
          : { runtime: failing };
      const operations = f.make(options);
      if (failure === 'result')
        await assert.rejects(operations.execute(f.workspace.id, f.member.userId, proposal.id), /division by zero/);
      else assert.deepEqual(await operations.execute(f.workspace.id, f.member.userId, proposal.id), uncertain);
      const expected =
        failure === 'result'
          ? { status: 'succeeded', result: { untrusted: true, data: { documentId: 'applied' } }, error: null }
          : uncertain;
      assert.deepEqual(
        (
          await f.db.platform.query(
            `SELECT status,result,error FROM ${f.table('tf_google_receipts')} WHERE proposal_id=$1`,
            [proposal.id],
          )
        ).rows,
        [expected],
      );
      assert.deepEqual(await f.make().execute(f.workspace.id, f.member.userId, proposal.id), expected);
    }
    assert.equal(f.calls.length, 2);
  } finally {
    await f.close();
  }
});

test('removed owner and readmitted admin cannot inherit proposals or integration', async () => {
  const f = await fixture();
  try {
    await f.connect();
    const proposal = await f.propose();
    await f.decide(proposal);
    await f.db.platform.query(`UPDATE ${f.table('tf_memberships')} SET removed_at=clock_timestamp() WHERE id=$1`, [
      f.member.membershipId,
    ]);
    await assert.rejects(f.execute(proposal), AccessDenied);
    await assert.rejects(f.operations.proposals(f.workspace.id, f.member.userId), AccessDenied);
    await f.db.platform.query(`INSERT INTO ${f.table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'admin')`, [
      randomUUID(),
      f.member.userId,
    ]);
    await assert.rejects(f.execute(proposal), AccessDenied);
    await assert.rejects(f.decide(proposal), AccessDenied);
    await assert.rejects(f.operations.proposal(f.workspace.id, f.member.userId, proposal.id), AccessDenied);
    assert.deepEqual(await f.operations.proposals(f.workspace.id, f.member.userId), {
      proposals: [],
      nextCursor: null,
    });
    await assert.rejects(f.propose(), /integration-required/);
    assert.equal(f.calls.length, 0);
    assert.deepEqual(await f.service.status(f.workspace.id, f.member.userId), { status: 'disconnected' });
  } finally {
    await f.close();
  }
});

test('proposal pages keep timestamp precision, stable ties and exact owner detail after disconnect', async () => {
  const f = await fixture();
  const w = f.workspace.id,
    u = f.member.userId;
  try {
    assert.deepEqual(await f.operations.proposals(w, u), { proposals: [], nextCursor: null });
    await f.connect();
    const proposals = [];
    for (let i = 0; i < 4; i++) proposals.push(await f.propose({ ...write, title: `private-title-${i}` }));
    await f.db.platform.query(
      `UPDATE ${f.table('tf_google_proposals')} SET created_at='2026-09-30T00:00:00.123456Z' WHERE id=ANY($1::uuid[])`,
      [proposals.map(proposal => proposal.id)],
    );
    await f.db.platform.query(
      `UPDATE ${f.table('tf_google_proposals')} SET created_at='2026-09-30T00:00:00.123457Z' WHERE id=$1`,
      [proposals[0].id],
    );
    await f.decide(proposals[0]);
    await f.execute(proposals[0]);
    await f.decide(proposals[1], 'reject');
    const admin = await f.connect({ userId: f.admin.userId, sessionId: randomUUID() });
    assert.equal(admin.status, 'connected');
    const other = await f.operations.propose(w, f.admin.userId, { commandId: randomUUID(), operation: write });
    const first = await f.operations.proposals(w, u, { limit: 1 });
    assert.equal(first.proposals[0].id, proposals[0].id);
    assert.equal(first.proposals[0].createdAt, '2026-09-30T00:00:00.123457Z');
    assert.equal(first.proposals[0].receiptStatus, 'succeeded');
    const inserted = await f.propose();
    await f.service.disconnect(w, u);
    const ids = [first.proposals[0].id];
    let cursor = first.nextCursor;
    while (cursor) {
      const page = await f.operations.proposals(w, u, { limit: 1, cursor });
      assert.equal(JSON.stringify(page).includes('private-title'), false);
      assert.deepEqual(Object.keys(page.proposals[0]).sort(), [
        'createdAt',
        'decision',
        'expiresAt',
        'id',
        'operationKind',
        'receiptStatus',
      ]);
      ids.push(page.proposals[0].id);
      cursor = page.nextCursor;
    }
    assert.deepEqual(ids, [
      proposals[0].id,
      ...proposals
        .slice(1)
        .map(proposal => proposal.id)
        .sort()
        .reverse(),
    ]);
    assert.equal(ids.includes(other.id), false);
    assert.equal(ids.includes(inserted.id), false);
    const detail = await f.operations.proposal(w, u, proposals[0].id);
    assert.deepEqual(detail.operation, { ...write, title: 'private-title-0' });
    assert.equal(detail.digest, proposals[0].digest);
    assert.deepEqual(detail.receipt.result, {
      untrusted: true,
      data: { documentId: 'document-1', title: write.title },
    });
    assert.deepEqual(await f.operations.proposals(w, f.admin.userId, { cursor: first.nextCursor }), {
      proposals: [],
      nextCursor: null,
    });
    await assert.rejects(f.operations.proposals(w, randomUUID()), AccessDenied);
  } finally {
    await f.close();
  }
});

test('a deferred outcome constraint fails COMMIT after Google success without losing the executing receipt', async () => {
  const f = await fixture();
  try {
    await f.connect();
    const proposal = await f.propose();
    await f.decide(proposal);
    await f.db.platform
      .query(`CREATE FUNCTION ${f.table('fail_outcome_commit')}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic outcome commit failure'; END $$;
      CREATE CONSTRAINT TRIGGER fail_outcome_commit AFTER UPDATE ON ${f.table('tf_google_receipts')} DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ${f.table('fail_outcome_commit')}()`);
    await assert.rejects(f.execute(proposal), /synthetic outcome commit failure/);
    assert.deepEqual(
      (
        await f.db.platform.query(
          `SELECT status,result,error FROM ${f.table('tf_google_receipts')} WHERE proposal_id=$1`,
          [proposal.id],
        )
      ).rows,
      [executing],
    );
    assert.deepEqual(await f.make().execute(f.workspace.id, f.member.userId, proposal.id), executing);
    assert.equal(f.calls.length, 1);
  } finally {
    await f.close();
  }
});

const docsUpdate = {
  kind: 'docs.documents.batchUpdate',
  documentId: 'doc-original',
  requests: [{ insertText: { location: { index: 1 }, text: 'Reviewed change' } }],
  requiredRevisionId: 'rev-1',
};
const slidesUpdate = {
  kind: 'slides.presentations.batchUpdate',
  presentationId: 'deck-original',
  requests: [{ deleteObject: { objectId: 'shape1' } }],
  requiredRevisionId: 'rev-1',
};
const failed = { status: 'failed', result: null, error: 'provider-request-failed' };
function revisionProvider(f, state) {
  f.provider(async (url, init) => {
    if (init.method === 'GET') {
      await state.onRead?.();
      return Response.json({ revisionId: state.revision });
    }
    state.writes.push(JSON.parse(init.body));
    return state.write
      ? state.write()
      : Response.json({ documentId: 'doc-original', replies: [{}], writeControl: { requiredRevisionId: 'rev-2' } });
  });
}
const receipts = (f, id) =>
  f.db.platform
    .query(`SELECT status,error FROM ${f.table('tf_google_receipts')} WHERE proposal_id=$1`, [id])
    .then(result => result.rows);

test('Docs and Slides updates bind the revision observed at proposal time and write with writeControl', async () => {
  const f = await fixture();
  try {
    await f.connect();
    const state = { revision: 'rev-1', writes: [] };
    revisionProvider(f, state);
    await assert.rejects(f.propose({ ...docsUpdate, requiredRevisionId: undefined }), /operation-revision-required/);
    await assert.rejects(f.propose({ ...slidesUpdate, requiredRevisionId: undefined }), /operation-revision-required/);
    assert.equal(f.calls.length, 0);
    state.revision = 'rev-newer';
    await assert.rejects(f.propose(docsUpdate), /operation-target-stale/);
    assert.equal(
      (await f.db.platform.query(`SELECT count(*)::integer AS count FROM ${f.table('tf_google_proposals')}`)).rows[0]
        .count,
      0,
    );
    state.revision = 'rev-1';
    for (const operation of [docsUpdate, slidesUpdate]) {
      const commandId = randomUUID();
      const proposal = await f.propose(operation, commandId);
      assert.deepEqual(proposal.operation, operation);
      state.revision = 'rev-moved-on';
      assert.deepEqual(await f.propose(operation, commandId), proposal);
      state.revision = 'rev-1';
      await f.decide(proposal);
      assert.equal((await f.execute(proposal)).status, 'succeeded');
    }
    assert.deepEqual(
      state.writes.map(body => body.writeControl),
      [{ requiredRevisionId: 'rev-1' }, { requiredRevisionId: 'rev-1' }],
    );
    assert.deepEqual(
      f.calls.map(call => [call.init.method, new URL(call.url).pathname, new URL(call.url).searchParams.get('fields')]),
      [
        ['GET', '/v1/documents/doc-original', 'revisionId'],
        ['GET', '/v1/documents/doc-original', 'revisionId'],
        ['GET', '/v1/documents/doc-original', 'revisionId'],
        ['POST', '/v1/documents/doc-original:batchUpdate', null],
        ['GET', '/v1/presentations/deck-original', 'revisionId'],
        ['GET', '/v1/presentations/deck-original', 'revisionId'],
        ['POST', '/v1/presentations/deck-original:batchUpdate', null],
      ],
    );
  } finally {
    await f.close();
  }
});

test('an intervening edit after approval blocks the write and needs a refreshed proposal', async () => {
  const f = await fixture();
  try {
    await f.connect();
    const state = { revision: 'rev-1', writes: [] };
    revisionProvider(f, state);
    const proposal = await f.propose(docsUpdate);
    await f.decide(proposal);
    state.revision = 'rev-2';
    await assert.rejects(f.execute(proposal), /operation-target-stale/);
    await assert.rejects(f.execute(proposal), /operation-target-stale/);
    assert.deepEqual(await receipts(f, proposal.id), []);
    assert.equal(state.writes.length, 0);
    const refreshed = await f.propose({ ...docsUpdate, requiredRevisionId: 'rev-2' });
    await assert.rejects(f.execute(refreshed), /operation-approval-required/);
    assert.equal(state.writes.length, 0);
    await f.decide(refreshed);
    assert.equal((await f.execute(refreshed)).status, 'succeeded');
    assert.deepEqual(
      state.writes.map(body => body.writeControl),
      [{ requiredRevisionId: 'rev-2' }],
    );
  } finally {
    await f.close();
  }
});

test('a provider revision mismatch at write time records a failed receipt and never retries with a newer revision', async () => {
  const f = await fixture();
  try {
    await f.connect();
    const state = {
      revision: 'rev-1',
      writes: [],
      write: () =>
        Response.json(
          { error: { code: 400, message: 'The required revision ID does not match.', status: 'FAILED_PRECONDITION' } },
          { status: 400 },
        ),
    };
    revisionProvider(f, state);
    const proposal = await f.propose(docsUpdate);
    await f.decide(proposal);
    await assert.rejects(f.execute(proposal), /operation-target-stale/);
    assert.deepEqual(await receipts(f, proposal.id), [{ status: 'failed', error: 'provider-request-failed' }]);
    state.revision = 'rev-2';
    assert.deepEqual(await f.make().execute(f.workspace.id, f.member.userId, proposal.id), failed);
    assert.deepEqual(
      state.writes.map(body => body.writeControl),
      [{ requiredRevisionId: 'rev-1' }],
    );
  } finally {
    await f.close();
  }
});

test('authorization loss between approval and the reviewed write blocks the write', async () => {
  const f = await fixture();
  try {
    const connected = await f.connect();
    const state = { revision: 'rev-1', writes: [] };
    revisionProvider(f, state);
    const afterRevisionCheck = mutate =>
      f.make({
        integrations: {
          ...f.service,
          async withCredential(fence, operation) {
            const result = await f.service.withCredential(fence, operation);
            await mutate();
            return result;
          },
        },
      });
    const raced = await f.propose(docsUpdate);
    await f.decide(raced);
    await assert.rejects(
      afterRevisionCheck(() =>
        f.db.platform.query(`UPDATE ${f.table('tf_google_integrations')} SET generation=$1`, [
          connected.generation + 1,
        ]),
      ).execute(f.workspace.id, f.member.userId, raced.id),
      /operation-conflict/,
    );
    assert.deepEqual(await receipts(f, raced.id), []);
    await f.db.platform.query(`UPDATE ${f.table('tf_google_integrations')} SET generation=$1`, [connected.generation]);
    const removed = await f.propose(docsUpdate);
    await f.decide(removed);
    await assert.rejects(
      afterRevisionCheck(() =>
        f.db.platform.query(`UPDATE ${f.table('tf_memberships')} SET removed_at=clock_timestamp() WHERE id=$1`, [
          f.member.membershipId,
        ]),
      ).execute(f.workspace.id, f.member.userId, removed.id),
      AccessDenied,
    );
    assert.deepEqual(await receipts(f, removed.id), []);
    assert.equal(f.calls.filter(call => call.init.method === 'GET').length, 4);
    assert.equal(state.writes.length, 0);
  } finally {
    await f.close();
  }
});

test('an uncertain reviewed write stays outcome-unknown without replay', async () => {
  const f = await fixture();
  try {
    await f.connect();
    const state = {
      revision: 'rev-1',
      writes: [],
      write: () => {
        throw new Error('private transport failure');
      },
    };
    revisionProvider(f, state);
    const proposal = await f.propose(docsUpdate);
    await f.decide(proposal);
    assert.deepEqual(await f.execute(proposal), uncertain);
    assert.deepEqual(await f.make().execute(f.workspace.id, f.member.userId, proposal.id), uncertain);
    assert.equal(state.writes.length, 1);
    assert.equal(f.calls.length, 3);
  } finally {
    await f.close();
  }
});

test('Sheets and Drive content overwrites of Google originals are refused, including approved legacy proposals', async () => {
  const f = await fixture();
  try {
    await f.connect();
    for (const operation of [
      {
        kind: 'sheets.values.update',
        spreadsheetId: 'sheet-original',
        range: 'A1',
        values: [['x']],
        valueInputOption: 'RAW',
      },
      {
        kind: 'sheets.values.batchUpdate',
        spreadsheetId: 'sheet-original',
        valueInputOption: 'RAW',
        data: [{ range: 'A1', values: [['x']] }],
      },
      { kind: 'sheets.values.clear', spreadsheetId: 'sheet-original', range: 'A1' },
      { kind: 'sheets.values.batchClear', spreadsheetId: 'sheet-original', ranges: ['A1'] },
      {
        kind: 'sheets.spreadsheets.batchUpdate',
        spreadsheetId: 'sheet-original',
        requests: [{ deleteSheet: { sheetId: 1 } }],
      },
      { kind: 'drive.files.upload', fileId: 'file-original', mimeType: 'text/plain', contentBase64: 'aGVsbG8=' },
    ])
      await assert.rejects(f.propose(operation), /operation-unguarded-update/, operation.kind);
    const legacy = await f.propose();
    await f.db.platform.query(
      `UPDATE ${f.table('tf_google_proposals')} SET operation=$2,required_scopes=$3 WHERE id=$1`,
      [
        legacy.id,
        {
          kind: 'sheets.values.update',
          spreadsheetId: 'sheet-original',
          range: 'A1',
          values: [['x']],
          valueInputOption: 'RAW',
        },
        ['https://www.googleapis.com/auth/spreadsheets'],
      ],
    );
    await f.db.platform.query(
      `UPDATE ${f.table('tf_google_integrations')} SET scopes=array_append(scopes,'https://www.googleapis.com/auth/spreadsheets')`,
    );
    await f.decide(legacy);
    await assert.rejects(f.execute(legacy), /operation-unguarded-update/);
    assert.deepEqual(await receipts(f, legacy.id), []);
    assert.equal(
      (await f.propose({ kind: 'drive.files.upload', mimeType: 'text/plain', contentBase64: 'aGVsbG8=' })).operation
        .kind,
      'drive.files.upload',
    );
    assert.equal(f.calls.length, 0);
  } finally {
    await f.close();
  }
});

test('Sheets in-place writes are allowed on spreadsheets this workspace created, copied, or uploaded, and refused on other originals', async () => {
  const f = await fixture();
  try {
    await f.connect();
    const run = async operation => {
      const proposal = await f.propose(operation);
      await f.decide(proposal);
      return f.execute(proposal);
    };
    f.provider(async () => Response.json({ spreadsheetId: 'sheet-made', properties: { title: 'Stock' } }));
    assert.equal((await run({ kind: 'sheets.spreadsheets.create', title: 'Stock' })).status, 'succeeded');
    f.provider(async () =>
      Response.json({
        id: 'sheet-copied',
        name: 'Copy of Budget',
        mimeType: 'application/vnd.google-apps.spreadsheet',
      }),
    );
    assert.equal(
      (await run({ kind: 'drive.files.copy', fileId: 'sheet-original', file: { name: 'Copy of Budget' } })).status,
      'succeeded',
    );
    f.provider(async () =>
      Response.json({ id: 'sheet-uploaded', name: 'Plan', mimeType: 'application/vnd.google-apps.spreadsheet' }),
    );
    assert.equal(
      (
        await run({
          kind: 'drive.files.upload',
          mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          contentBase64: 'aGVsbG8=',
          file: { name: 'Plan', mimeType: 'application/vnd.google-apps.spreadsheet' },
        })
      ).status,
      'succeeded',
    );
    const writes = spreadsheetId => [
      { kind: 'sheets.values.update', spreadsheetId, range: 'A1', values: [['x']], valueInputOption: 'RAW' },
      {
        kind: 'sheets.values.batchUpdate',
        spreadsheetId,
        valueInputOption: 'RAW',
        data: [{ range: 'A1', values: [['x']] }],
      },
      { kind: 'sheets.values.clear', spreadsheetId, range: 'A1' },
      { kind: 'sheets.spreadsheets.batchUpdate', spreadsheetId, requests: [{ deleteSheet: { sheetId: 1 } }] },
    ];
    f.provider(async url =>
      String(url).startsWith('https://www.googleapis.com/drive/v3/files/')
        ? Response.json({ version: '5' })
        : Response.json({ spreadsheetId: 'written' }),
    );
    for (const spreadsheetId of ['sheet-made', 'sheet-copied', 'sheet-uploaded'])
      for (const operation of writes(spreadsheetId)) {
        assert.equal((await run(operation)).status, 'succeeded', `${operation.kind} on ${spreadsheetId}`);
        assert.ok(
          f.calls.at(-2).url.startsWith(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}`),
          f.calls.at(-2).url,
        );
      }
    const calls = f.calls.length;
    for (const operation of [
      ...writes('sheet-original'),
      { kind: 'sheets.values.batchClear', spreadsheetId: 'sheet-made', ranges: ['A1'] },
    ])
      await assert.rejects(
        f.propose(operation),
        /operation-unguarded-update/,
        `${operation.kind} on ${operation.spreadsheetId}`,
      );
    f.provider(async () => Response.json({ error: { code: 400, status: 'INVALID_ARGUMENT' } }, { status: 400 }));
    assert.equal((await run({ kind: 'sheets.spreadsheets.create', title: 'Never made' })).status, 'failed');
    await assert.rejects(
      f.propose(writes('written')[0]),
      /operation-unguarded-update/,
      'a failed create records no spreadsheet',
    );
    assert.equal(f.calls.length, calls + 1);

    f.provider(async () => Response.json({ version: '5' }));
    const approved = await f.propose(writes('sheet-made')[0]);
    await f.db.platform.query(`UPDATE ${f.table('tf_google_proposals')} SET operation=$2 WHERE id=$1`, [
      approved.id,
      writes('sheet-original')[0],
    ]);
    await f.decide(approved);
    await assert.rejects(
      f.execute(approved),
      /operation-unguarded-update/,
      'execution checks the creation receipt again',
    );
    assert.deepEqual(await receipts(f, approved.id), []);
  } finally {
    await f.close();
  }
});

const sheetWrite = {
  kind: 'sheets.values.update',
  spreadsheetId: 'sheet-made',
  range: 'A1',
  values: [['Reviewed']],
  valueInputOption: 'RAW',
};
/** A created spreadsheet whose Drive `version` the test moves, standing in for a person editing it in Google Sheets. */
async function versionedSheet(f) {
  const state = { version: '10', reads: [], writes: 0, onRead: null, onWrite: null };
  f.provider(async () => Response.json({ spreadsheetId: 'sheet-made' }));
  const created = await f.propose({ kind: 'sheets.spreadsheets.create', title: 'Stock' });
  await f.decide(created);
  await f.execute(created);
  f.provider(async url => {
    if (String(url).startsWith('https://www.googleapis.com/drive/v3/files/sheet-made')) {
      assert.equal(new URL(String(url)).searchParams.get('fields'), 'version');
      const version = state.version;
      state.reads.push(version);
      state.onRead?.(state.reads.length);
      return Response.json({ version });
    }
    state.writes++;
    state.onWrite?.();
    return Response.json({ spreadsheetId: 'sheet-made', updatedCells: 1 });
  });
  return state;
}
const residualRace =
  'An edit saved between the final Drive version read and this write is not detected and may have been overwritten.';

test('Sheets writes on a created spreadsheet bind the Drive version at proposal and record it after the write', async () => {
  const f = await fixture();
  try {
    await f.connect();
    const sheet = await versionedSheet(f);
    const commandId = randomUUID();
    const proposal = await f.propose(sheetWrite, commandId);
    assert.deepEqual(
      proposal.operation,
      { ...sheetWrite, requiredVersion: '10' },
      'the reviewed proposal shows the version it was made against',
    );
    sheet.version = '11';
    assert.deepEqual(
      await f.propose(sheetWrite, commandId),
      proposal,
      'a replay returns the bound proposal without reading again',
    );
    await assert.rejects(
      f.propose({ ...sheetWrite, requiredVersion: '10' }),
      /operation-target-stale/,
      'a version the agent read before a later edit is stale',
    );
    sheet.version = '10';
    await f.decide(proposal);
    sheet.onWrite = () => {
      sheet.version = '12';
    };
    assert.deepEqual(await f.execute(proposal), {
      status: 'succeeded',
      error: null,
      result: {
        untrusted: true,
        data: { spreadsheetId: 'sheet-made', updatedCells: 1 },
        versionGuard: { requiredVersion: '10', versionAfterWrite: '12', residualRace },
      },
    });
    assert.deepEqual(
      sheet.reads,
      ['10', '11', '10', '10', '12'],
      'proposal, refused proposal, pre-claim check, the read just before the write, and the read after it',
    );
    assert.equal(sheet.writes, 1);
  } finally {
    await f.close();
  }
});

test('a Sheets-only integration is refused at proposal time with the missing Drive scope, before any Drive read', async () => {
  const f = await fixture();
  try {
    await f.connect();
    const sheet = await versionedSheet(f);
    const calls = f.calls.length;
    await f.db.platform.query(`UPDATE ${f.table('tf_google_integrations')} SET scopes=$1`, [
      ['openid', 'https://www.googleapis.com/auth/userinfo.email', 'https://www.googleapis.com/auth/spreadsheets'],
    ]);
    await assert.rejects(
      f.propose(sheetWrite),
      error =>
        error.code === 'insufficient-scope' &&
        JSON.stringify(error.missingScopes) === JSON.stringify(['https://www.googleapis.com/auth/drive']),
    );
    assert.deepEqual(sheet.reads, []);
    assert.equal(f.calls.length, calls);
    assert.equal(
      (
        await f.propose({
          kind: 'sheets.values.append',
          spreadsheetId: 'sheet-made',
          range: 'A1',
          values: [['x']],
          valueInputOption: 'RAW',
        })
      ).integration.requiredScopes.join(),
      'https://www.googleapis.com/auth/spreadsheets',
      'appends need no version read',
    );
  } finally {
    await f.close();
  }
});

test('a person editing a created spreadsheet after approval blocks the Sheets write and needs a refreshed approval', async () => {
  const f = await fixture();
  try {
    await f.connect();
    const sheet = await versionedSheet(f);
    const proposal = await f.propose(sheetWrite);
    await f.decide(proposal);
    sheet.version = '11';
    await assert.rejects(f.execute(proposal), /operation-target-stale/);
    assert.deepEqual(await receipts(f, proposal.id), [], 'an edit seen before the claim records no receipt');
    assert.equal(sheet.writes, 0);
    const refreshed = await f.propose(sheetWrite);
    assert.equal(refreshed.operation.requiredVersion, '11');
    await assert.rejects(f.execute(refreshed), /operation-approval-required/);
    await f.decide(refreshed);
    assert.equal((await f.execute(refreshed)).status, 'succeeded');
    assert.equal(sheet.writes, 1);
  } finally {
    await f.close();
  }
});

test('an edit landing between the pre-claim check and the write fails the receipt and never writes', async () => {
  const f = await fixture();
  try {
    await f.connect();
    const sheet = await versionedSheet(f);
    const proposal = await f.propose(sheetWrite);
    await f.decide(proposal);
    const reads = sheet.reads.length;
    sheet.onRead = count => {
      if (count === reads + 1) sheet.version = '11';
    };
    await assert.rejects(f.execute(proposal), /operation-target-stale/);
    assert.deepEqual(await receipts(f, proposal.id), [{ status: 'failed', error: 'provider-request-failed' }]);
    assert.equal(sheet.writes, 0, 'the read just before the write saw the edit');
    assert.deepEqual(await f.execute(proposal), failed, 'the failed proposal is never retried');
    assert.equal(sheet.writes, 0);
  } finally {
    await f.close();
  }
});

test('a Sheets proposal approved before versions were bound must be proposed again', async () => {
  const f = await fixture();
  try {
    await f.connect();
    const sheet = await versionedSheet(f);
    const legacy = await f.propose(sheetWrite);
    await f.db.platform.query(`UPDATE ${f.table('tf_google_proposals')} SET operation=$2 WHERE id=$1`, [
      legacy.id,
      sheetWrite,
    ]);
    await f.decide(legacy);
    await assert.rejects(f.execute(legacy), /operation-revision-required/);
    assert.deepEqual(await receipts(f, legacy.id), []);
    assert.equal(sheet.writes, 0);
  } finally {
    await f.close();
  }
});

const append = {
  kind: 'sheets.values.append',
  spreadsheetId: 'sheet-original',
  range: 'A1',
  values: [['Tulips', 40]],
  valueInputOption: 'RAW',
};
const overwrite = { ...append, insertDataOption: 'OVERWRITE' };
const proposalCount = f =>
  f.db.platform
    .query(`SELECT count(*)::integer AS count FROM ${f.table('tf_google_proposals')}`)
    .then(result => result.rows[0].count);

test('a Sheets append that would overwrite cells is refused at proposal, at approval, and at execution of a stored proposal', async () => {
  const f = await fixture();
  try {
    await f.connect();
    await assert.rejects(f.propose(overwrite), /operation-unguarded-update/);
    assert.equal(await proposalCount(f), 0);
    const unreviewed = await f.propose(append);
    await f.db.platform.query(`UPDATE ${f.table('tf_google_proposals')} SET operation=$2 WHERE id=$1`, [
      unreviewed.id,
      overwrite,
    ]);
    assert.deepEqual(
      (await f.operations.proposal(f.workspace.id, f.member.userId, unreviewed.id)).operation,
      overwrite,
    );
    await assert.rejects(f.decide(unreviewed), /operation-unguarded-update/);
    await assert.rejects(f.execute(unreviewed), /operation-approval-required/);
    const legacy = await f.propose(append);
    await f.decide(legacy);
    await f.db.platform.query(`UPDATE ${f.table('tf_google_proposals')} SET operation=$2 WHERE id=$1`, [
      legacy.id,
      overwrite,
    ]);
    await assert.rejects(f.execute(legacy), /operation-unguarded-update/);
    await assert.rejects(f.execute(legacy), /operation-unguarded-update/);
    assert.deepEqual(await receipts(f, legacy.id), []);
    assert.equal(f.calls.length, 0);
  } finally {
    await f.close();
  }
});

test('Sheets appends insert rows on any spreadsheet, with or without an explicit INSERT_ROWS', async () => {
  const f = await fixture();
  try {
    await f.connect();
    f.provider(async () =>
      Response.json({ spreadsheetId: 'sheet-original', updates: { updatedRange: 'Sheet1!A2:B2', updatedRows: 1 } }),
    );
    for (const operation of [append, { ...append, insertDataOption: 'INSERT_ROWS' }]) {
      const proposal = await f.propose(operation);
      assert.deepEqual(proposal.operation, operation);
      await f.decide(proposal);
      assert.equal((await f.execute(proposal)).status, 'succeeded');
    }
    assert.deepEqual(
      f.calls.map(call => [
        call.init.method,
        new URL(call.url).pathname,
        new URL(call.url).searchParams.get('insertDataOption'),
      ]),
      [
        ['POST', '/v4/spreadsheets/sheet-original/values/A1:append', 'INSERT_ROWS'],
        ['POST', '/v4/spreadsheets/sheet-original/values/A1:append', 'INSERT_ROWS'],
      ],
    );
  } finally {
    await f.close();
  }
});

test('proposals made for one Google account stay refused after consent switches accounts and back, and survive consent for the same account', async () => {
  const f = await fixture();
  try {
    const first = await f.connect();
    const approved = await f.propose();
    await f.decide(approved);
    const unreviewed = await f.propose();
    f.behavior({ account: 'other-account' });
    await f.connect();
    f.behavior({});
    const back = await f.connect();
    assert.deepEqual([back.accountId, back.scopes], [first.accountId, first.scopes]);
    await assert.rejects(f.execute(approved), /operation-conflict/);
    await assert.rejects(f.decide(unreviewed), /operation-conflict/);
    assert.deepEqual(await receipts(f, approved.id), []);
    assert.equal(f.calls.length, 0);
    const kept = await f.propose();
    await f.decide(kept);
    assert.equal((await f.connect()).generation, back.generation);
    assert.equal((await f.execute(kept)).status, 'succeeded');
    assert.equal(f.calls.length, 1);
  } finally {
    await f.close();
  }
});
