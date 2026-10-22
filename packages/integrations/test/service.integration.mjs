import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { test } from 'node:test';
import { Client } from 'pg';
import { fixture } from './fixture.mjs';

test('integration pickers hide reserved internal teams without removing memberships or grants', async () => {
  const f = await fixture();
  try {
    const adminTeam = (await f.owner.query(`SELECT id FROM ${f.table('tf_teams')} WHERE name = '_admin'`)).rows[0].id;
    const internalTeam = randomUUID();
    const visibleTeam = randomUUID();
    await f.owner.query(
      `INSERT INTO ${f.table('tf_teams')} (id, name) VALUES ($1, '_internal'), ($2, 'Customer_admin')`,
      [internalTeam, visibleTeam],
    );
    await f.owner.query(
      `INSERT INTO ${f.table('tf_member_teams')} (membership_id, team_id) VALUES ($1,$2), ($1,$3), ($1,$4)`,
      [f.creator.membershipId, adminTeam, internalTeam, visibleTeam],
    );
    await f.service.create(f.workspaceId, f.creator, f.input);
    await f.service.setGrants(f.workspaceId, f.creator, f.input.id, {
      expectedGrantsVersion: 1,
      grants: [{ teamId: adminTeam, permissions: ['read', 'use'] }],
      sourceGrants: [],
    });
    const expected = [
      { id: visibleTeam, name: 'Customer_admin' },
      { id: f.teamId, name: 'Engineering' },
      { id: f.otherTeamId, name: 'Other' },
    ];
    const collaborators = await f.service.collaborators(f.workspaceId, f.creator);
    assert.deepEqual(collaborators.teams, expected);
    assert.ok(collaborators.members.some(member => member.id === f.creator.membershipId));
    assert.deepEqual((await f.service.creationContext(f.workspaceId, f.creator)).teams, expected);
    assert.deepEqual((await f.service.collaborators(f.workspaceId, f.member)).teams, [
      { id: f.teamId, name: 'Engineering' },
    ]);
    assert.deepEqual((await f.service.collaborators(f.workspaceId, f.actor)).teams, []);
    assert.deepEqual((await f.service.get(f.workspaceId, f.creator, f.input.id)).grants, [
      { teamId: adminTeam, permissions: ['read', 'use'] },
    ]);
    assert.equal(
      (
        await f.owner.query(`SELECT 1 FROM ${f.table('tf_member_teams')} WHERE membership_id=$1 AND team_id=$2`, [
          f.creator.membershipId,
          adminTeam,
        ])
      ).rowCount,
      1,
    );
  } finally {
    await f.close();
  }
});

test('UUID casing preserves encrypted credentials, creation replay and dispatch identity', async () => {
  const f = await fixture();
  try {
    const { workspaceId: w, service: s, creator: a, input: i } = f;
    const upperActor = { ...a, membershipId: a.membershipId.toUpperCase() };
    const upper = {
      ...i,
      id: i.id.toUpperCase(),
      owningTeamId: i.owningTeamId.toUpperCase(),
      repositories: i.repositories.map(source => ({ ...source, id: source.id.toUpperCase() })),
    };
    assert.equal((await s.create(w.toUpperCase(), upperActor, upper)).id, i.id);
    assert.equal((await s.create(w, a, i)).id, i.id);
    await s.setGrants(w, a, i.id, {
      expectedGrantsVersion: 1,
      grants: [],
      sourceGrants: [],
      sourcePersonGrants: [f.sourceGrant(a)],
    });
    const request = f.request();
    const expected = {
      number: 17,
      title: 'Issue title',
      body: 'Issue body',
      state: 'open',
      url: 'https://github.com/tulipfarm/fixture/issues/17',
    };
    assert.deepEqual(await s.readIssue(w, a, request), expected);
    const upperRequest = Object.fromEntries(
      Object.entries(request).map(([key, value]) => [key, typeof value === 'string' ? value.toUpperCase() : value]),
    );
    assert.deepEqual(await s.readIssue(w.toUpperCase(), upperActor, upperRequest), expected);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0][1].headers.Authorization, 'Bearer private-test-token');
    assert.equal(
      (await s.rotate(w.toUpperCase(), upperActor, upper.id, { expectedGeneration: 1, token: 'rotated-token' }))
        .generation,
      2,
    );
    assert.deepEqual(await s.readIssue(w, a, f.request()), expected);
    assert.equal(f.calls.at(-1)[1].headers.Authorization, 'Bearer rotated-token');
  } finally {
    await f.close();
  }
});

test('grant replacement rejects stale versions and concurrent edits preserve the winning policy', async () => {
  const f = await fixture();
  try {
    const { workspaceId: w, service: s, creator: a, input: i } = f;
    assert.equal((await s.create(w, a, i)).grantsVersion, 1);
    const initial = {
      expectedGrantsVersion: 1,
      grants: [{ teamId: f.teamId, permissions: ['read', 'use'] }],
      sourceGrants: [{ teamId: f.teamId, sourceId: i.repositories[0].id }],
    };
    assert.equal((await s.setGrants(w, a, i.id, initial)).grantsVersion, 2);
    await assert.rejects(s.setGrants(w, a, i.id, { ...initial, grants: [], sourceGrants: [] }), /conflict/);
    await assert.rejects(
      s.setGrants(w, a, i.id, {
        ...initial,
        expectedGrantsVersion: 2,
        sourceGrants: [{ teamId: f.teamId, sourceId: randomUUID() }],
      }),
      /not found/,
    );
    assert.equal((await s.get(w, a, i.id)).grantsVersion, 2);
    assert.equal((await s.readIssue(w, f.member, f.request())).title, 'Issue title');
    const policies = [
      { expectedGrantsVersion: 2, grants: [{ teamId: f.teamId, permissions: ['read'] }], sourceGrants: [] },
      {
        expectedGrantsVersion: 2,
        grants: [{ teamId: f.otherTeamId, permissions: ['read', 'manage'] }],
        sourceGrants: [],
      },
    ];
    const outcomes = await Promise.allSettled(policies.map(policy => s.setGrants(w, a, i.id, policy)));
    assert.deepEqual(outcomes.map(outcome => outcome.status).sort(), ['fulfilled', 'rejected']);
    const winner = outcomes.findIndex(outcome => outcome.status === 'fulfilled');
    assert.match(outcomes.find(outcome => outcome.status === 'rejected').reason.message, /conflict/);
    const detail = await s.get(w, a, i.id);
    assert.equal(detail.grantsVersion, 3);
    assert.deepEqual(
      detail.grants,
      policies[winner].grants.map(grant => ({ ...grant, permissions: [...grant.permissions].sort() })),
    );
    assert.deepEqual(detail.sourceGrants, []);
    assert.equal((await s.list(w, a)).integrations[0].grantsVersion, 3);
    assert.equal(
      (
        await f.owner.query(
          `SELECT count(*)::int AS count FROM ${f.table('tf_audit_events')} WHERE operation = 'integration.grants'`,
        )
      ).rows[0].count,
      2,
    );
  } finally {
    await f.close();
  }
});

test('creation permissions read back saved teams and reject concurrent replacement', async () => {
  const f = await fixture();
  try {
    const { workspaceId: w, service: s, creator: a } = f;
    await assert.rejects(s.creationGrants(w, f.member, f.teamId), /not found/);
    await assert.rejects(s.creationGrants(w, f.actor, f.teamId), /not found/);
    const empty = await s.creationGrants(w, a, f.teamId);
    assert.deepEqual(empty.teamIds, []);
    await s.setCreationGrants(w, a, { owningTeamId: f.teamId, teamIds: [f.teamId], expectedVersion: empty.version });
    const saved = await s.creationGrants(w, a, f.teamId);
    assert.deepEqual(saved.teamIds, [f.teamId]);
    const outcomes = await Promise.allSettled([
      s.setCreationGrants(w, a, {
        owningTeamId: f.teamId,
        teamIds: [...saved.teamIds, f.otherTeamId],
        expectedVersion: saved.version,
      }),
      s.setCreationGrants(w, a, { owningTeamId: f.teamId, teamIds: [], expectedVersion: saved.version }),
    ]);
    assert.deepEqual(outcomes.map(item => item.status).sort(), ['fulfilled', 'rejected']);
    const current = await s.creationGrants(w, a, f.teamId);
    assert.deepEqual(current.teamIds, outcomes[0].status === 'fulfilled' ? [f.teamId, f.otherTeamId].sort() : []);
    await assert.rejects(
      s.setCreationGrants(w, a, { owningTeamId: f.teamId, teamIds: [f.otherTeamId], expectedVersion: saved.version }),
      /conflict/,
    );
    assert.deepEqual(await s.creationGrants(w, a, f.teamId), current);
  } finally {
    await f.close();
  }
});

test('mixed-case workspace and request IDs acquire the canonical dispatch advisory lock', async () => {
  const f = await fixture();
  const request = f.request();
  const lock = `integration-dispatch:${f.workspaceId}:${request.requestId}`;
  let pending;
  try {
    await f.service.create(f.workspaceId, f.creator, f.input);
    await f.service.setGrants(f.workspaceId, f.creator, f.input.id, {
      expectedGrantsVersion: 1,
      grants: [],
      sourceGrants: [],
      sourcePersonGrants: [f.sourceGrant(f.creator)],
    });
    await f.owner.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [lock]);
    const upperRequest = Object.fromEntries(
      Object.entries(request).map(([key, value]) => [key, typeof value === 'string' ? value.toUpperCase() : value]),
    );
    pending = f.service.readIssue(f.workspaceId.toUpperCase(), f.creator, upperRequest);
    let waiting = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      waiting =
        (
          await f.owner.query("SELECT 1 FROM pg_stat_activity WHERE usename = $1 AND wait_event = 'advisory'", [
            new URL(f.url('runtime')).username,
          ])
        ).rowCount === 1;
      if (waiting) break;
      await setTimeout(10);
    }
    assert.equal(waiting, true, 'dispatch waits on the same PostgreSQL lock as its lowercase identity');
    assert.equal(f.calls.length, 0);
    await f.owner.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lock]);
    assert.equal((await pending).title, 'Issue title');
    assert.equal(f.calls.length, 1);
  } finally {
    await f.owner.query('SELECT pg_advisory_unlock_all()');
    await pending?.catch(() => undefined);
    await f.close();
  }
});

test('deleted integrations retain historical identities without preventing owning-team deletion', async () => {
  const f = await fixture();
  try {
    await f.service.create(f.workspaceId, f.creator, f.input);
    await f.service.setGrants(f.workspaceId, f.creator, f.input.id, {
      expectedGrantsVersion: 1,
      grants: [],
      sourceGrants: [],
      sourcePersonGrants: [f.sourceGrant(f.creator)],
    });
    const request = f.request();
    assert.equal((await f.service.readIssue(f.workspaceId, f.creator, request)).title, 'Issue title');
    await f.owner.query(`DELETE FROM ${f.table('tf_member_teams')} WHERE team_id = $1`, [f.teamId]);
    await assert.rejects(
      f.owner.query(`DELETE FROM ${f.table('tf_teams')} WHERE id = $1`, [f.teamId]),
      error => error.code === '23503',
    );
    assert.equal((await f.service.remove(f.workspaceId, f.creator, f.input.id)).removed, true);
    assert.equal(
      (await f.owner.query(`DELETE FROM ${f.table('tf_teams')} WHERE id = $1 RETURNING id`, [f.teamId])).rows[0].id,
      f.teamId,
    );
    assert.deepEqual(
      (
        await f.owner.query(
          `SELECT owning_team_id, live_owning_team_id, enabled, credential FROM ${f.table('tf_integrations')} WHERE id = $1`,
          [f.input.id],
        )
      ).rows[0],
      { owning_team_id: f.teamId, live_owning_team_id: null, enabled: false, credential: null },
    );
    assert.deepEqual(
      (
        await f.owner.query(
          `SELECT integration_id, source_id, status FROM ${f.table('tf_integration_dispatches')} WHERE request_id = $1`,
          [request.requestId],
        )
      ).rows[0],
      { integration_id: f.input.id, source_id: f.input.repositories[0].id, status: 'completed' },
    );
    await assert.rejects(f.service.readIssue(f.workspaceId, f.creator, request), /not found/);
    assert.equal(f.calls.length, 1);
  } finally {
    await f.close();
  }
});

test('restricted runtime separates metadata, use, management, source scope and creation', async () => {
  const f = await fixture();
  try {
    const { workspaceId: w, service: s, creator: a, member: m, actor: admin, input: i } = f;
    assert.equal((await s.create(w, a, i)).name, 'Triage');
    assert.equal((await s.create(w, a, i)).id, i.id);
    await assert.rejects(s.create(w, a, { ...i, token: 'different' }), /conflict/);
    await assert.rejects(s.create(w, admin, { ...i, id: randomUUID() }), /not found/);
    assert.deepEqual(await s.list(w, m), { integrations: [] });
    await assert.rejects(s.get(w, m, i.id), /not found/);
    const grants = (expectedGrantsVersion, permissions) => ({
      expectedGrantsVersion,
      grants: [{ teamId: f.teamId, permissions }],
      sourceGrants: [],
    });
    await s.setGrants(w, a, i.id, grants(1, ['read', 'manage']));
    const detail = await s.get(w, m, i.id);
    assert.deepEqual(detail.capabilities, { read: true, use: false, manage: true, administer: true });
    assert.equal((await s.update(w, m, i.id, { name: 'Renamed' })).name, 'Renamed');
    await assert.rejects(s.readIssue(w, m, f.request()), /not found/);
    await assert.rejects(s.transfer(w, m, i.id, { owningTeamId: f.otherTeamId }), /not found/);
    await s.setGrants(w, a, i.id, grants(2, ['read', 'use']));
    await assert.rejects(s.readIssue(w, m, f.request()), /not found/);
    await assert.rejects(s.update(w, m, i.id, { name: 'No longer manager' }), /not found/);
    await s.setGrants(w, a, i.id, {
      ...grants(3, ['read', 'use']),
      sourceGrants: [{ teamId: f.teamId, sourceId: i.repositories[0].id }],
    });
    const request = f.request();
    const expected = {
      number: 17,
      title: 'Issue title',
      body: 'Issue body',
      state: 'open',
      url: 'https://github.com/tulipfarm/fixture/issues/17',
    };
    assert.deepEqual(await s.readIssue(w, m, request), expected);
    assert.deepEqual(await s.readIssue(w, m, request), expected);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0][0], 'https://api.github.com/repos/tulipfarm/fixture/issues/17');
    assert.equal(f.calls[0][1].method, 'GET');
    assert.equal(f.calls[0][1].redirect, 'error');
    await assert.rejects(s.readIssue(w, a, request), /conflict/);
    await s.transfer(w, a, i.id, { owningTeamId: f.otherTeamId });
    assert.equal((await s.get(w, m, i.id)).capabilities.use, true);
    await s.setGrants(w, a, i.id, grants(4, ['read']));
    await assert.rejects(s.readIssue(w, m, request), /not found/);
    const created = { ...i, id: randomUUID(), repositories: [{ ...i.repositories[0], id: randomUUID() }] };
    await assert.rejects(s.setCreationGrants(w, m, { owningTeamId: f.teamId, teamIds: [f.teamId] }), /not found/);
    assert.deepEqual(await s.creationContext(w, m), { teams: [{ id: f.teamId, name: 'Engineering' }] });
    assert.deepEqual(await s.creationContext(w, admin), { teams: [] });
    assert.deepEqual((await s.create(w, m, created)).capabilities, {
      read: true,
      use: true,
      manage: true,
      administer: true,
    });
    await assert.rejects(s.get(w, a, created.id), /not found/);
    await assert.rejects(s.get(w, admin, created.id), /not found/);
    assert.equal((await s.create(w, m, created)).owningTeamId, f.teamId);
    const rotated = await s.rotate(w, a, i.id, { expectedGeneration: 1, token: 'rotated-token' });
    assert.equal(rotated.generation, 2);
    await assert.rejects(s.rotate(w, a, i.id, { expectedGeneration: 1, token: 'stale-token' }), /conflict/);
    await s.setGrants(w, a, i.id, { ...grants(5, ['read']), sourcePersonGrants: [f.sourceGrant(a)] });
    await s.readIssue(w, a, f.request());
    assert.equal(f.calls.at(-1)[1].headers.Authorization, 'Bearer rotated-token');
    const stored = JSON.stringify(
      (await f.owner.query(`SELECT row_to_json(c) FROM ${f.table('tf_integrations')} c`)).rows,
    );
    const dispatch = JSON.stringify(
      (await f.owner.query(`SELECT row_to_json(d) FROM ${f.table('tf_integration_dispatches')} d`)).rows,
    );
    for (const token of ['private-test-token', 'rotated-token', 'stale-token']) {
      assert.equal(stored.includes(token), false);
      assert.equal(dispatch.includes(token), false);
      assert.equal(JSON.stringify(rotated).includes(token), false);
    }
    await s.update(w, a, i.id, { enabled: false });
    await assert.rejects(s.readIssue(w, a, f.request()), /not found/);
    assert.equal((await s.remove(w, a, i.id)).removed, true);
    await assert.rejects(s.get(w, a, i.id), /not found/);
    assert.equal(
      (await f.owner.query(`SELECT credential FROM ${f.table('tf_integrations')} WHERE id = $1`, [i.id])).rows[0]
        .credential,
      null,
    );
  } finally {
    await f.close();
  }
});

test('dispatch commits before network and revocation wins before dispatch or prevents result disclosure', async () => {
  const f = await fixture();
  try {
    const { workspaceId: w, service: s, creator: a, member: m, input: i } = f;
    await s.create(w, a, i);
    const grants = {
      grants: [{ teamId: f.teamId, permissions: ['read', 'use'] }],
      sourceGrants: [{ teamId: f.teamId, sourceId: i.repositories[0].id }],
    };
    await s.setGrants(w, a, i.id, { ...grants, expectedGrantsVersion: 1 });
    let release;
    let started;
    const entered = new Promise(resolve => {
      started = resolve;
    });
    f.setProvider(async () => {
      started();
      await new Promise(resolve => {
        release = resolve;
      });
      return new Response(JSON.stringify({ number: 17, title: 'After dispatch', body: '', state: 'open' }));
    });
    const request = f.request();
    const running = s.readIssue(w, m, request);
    const denied = assert.rejects(running, /not found/);
    await entered;
    assert.equal(
      (
        await f.owner.query(`SELECT status FROM ${f.table('tf_integration_dispatches')} WHERE request_id = $1`, [
          request.requestId,
        ])
      ).rows[0].status,
      'executing',
    );
    await assert.rejects(s.readIssue(w, m, request), /in-progress/);
    await s.setGrants(w, a, i.id, { expectedGrantsVersion: 2, grants: [], sourceGrants: [] });
    release();
    await denied;
    assert.equal(f.calls.length, 1);
    await assert.rejects(s.readIssue(w, m, request), /not found/);
    await s.setGrants(w, a, i.id, { ...grants, expectedGrantsVersion: 3 });
    assert.equal((await s.readIssue(w, m, request)).title, 'After dispatch');
    assert.equal(f.calls.length, 1);
    await f.owner.query('BEGIN');
    await f.owner.query(`SELECT id FROM ${f.table('tf_authorization_lock')} WHERE id = 1 FOR UPDATE`);
    const queued = s.readIssue(w, m, f.request());
    const blocked = assert.rejects(queued, /not found/);
    await f.owner.query(`DELETE FROM ${f.table('tf_integration_grants')}`);
    await f.owner.query('COMMIT');
    await blocked;
    assert.equal(f.calls.length, 1);
  } finally {
    await f.close();
  }
});

test('SQL constraints reject wrong targets and non-runtime capabilities cannot read credentials', async () => {
  const f = await fixture();
  try {
    await f.service.create(f.workspaceId, f.creator, f.input);
    await assert.rejects(
      f.owner.query(
        `INSERT INTO ${f.table('tf_integration_grants')} (integration_id, team_id, permission) VALUES ($1,$2,'use')`,
        [f.input.id, f.teamId],
      ),
      error => error.code === '23503',
    );
    await assert.rejects(
      f.owner.query(
        `INSERT INTO ${f.table('tf_integration_source_grants')} (integration_id, source_id, team_id) VALUES ($1,$2,$3)`,
        [randomUUID(), f.input.repositories[0].id, f.teamId],
      ),
      error => error.code === '23503',
    );
    await assert.rejects(
      f.owner.query(`UPDATE ${f.table('tf_integrations')} SET owning_team_id = $2 WHERE id = $1`, [
        f.input.id,
        randomUUID(),
      ]),
      error => error.code === '23503',
    );
    await assert.rejects(
      f.owner.query(`DELETE FROM ${f.table('tf_teams')} WHERE id = $1`, [f.teamId]),
      error => error.code === '23503',
    );
    for (const capability of ['migration', 'confirmation']) {
      const client = new Client({ connectionString: f.url(capability) });
      await client.connect();
      try {
        await assert.rejects(
          client.query(`SELECT credential FROM ${f.table('tf_integrations')}`),
          error => error.code === '42501',
        );
      } finally {
        await client.end();
      }
    }
    assert.equal((await f.service.get(f.workspaceId, f.creator, f.input.id)).name, 'Triage');
    await assert.rejects(f.service.get(f.workspaceId, f.actor, f.input.id), /not found/);
  } finally {
    await f.close();
  }
});

test('failed attempts reauthorize and use current credentials; stale dispatch cannot duplicate the network operation', async () => {
  const f = await fixture();
  try {
    const { workspaceId: w, service: s, creator: a, input: i } = f;
    await s.create(w, a, i);
    await s.setGrants(w, a, i.id, {
      expectedGrantsVersion: 1,
      grants: [],
      sourceGrants: [],
      sourcePersonGrants: [f.sourceGrant(a)],
    });
    f.setProvider(async () => {
      throw new Error('private-test-token');
    });
    const failed = f.request();
    await assert.rejects(
      s.readIssue(w, a, failed),
      error => error.message === 'Integration operation provider-retryable',
    );
    await s.rotate(w, a, i.id, { expectedGeneration: 1, token: 'new-token' });
    f.setProvider(async () => new Response(JSON.stringify({ number: 17, title: 'Retried', body: '', state: 'open' })));
    assert.equal((await s.readIssue(w, a, failed)).title, 'Retried');
    assert.equal(f.calls.at(-1)[1].headers.Authorization, 'Bearer new-token');
    assert.equal(
      (
        await f.owner.query(`SELECT attempt FROM ${f.table('tf_integration_dispatches')} WHERE request_id = $1`, [
          failed.requestId,
        ])
      ).rows[0].attempt,
      2,
    );
    let entered;
    let release;
    const started = new Promise(resolve => {
      entered = resolve;
    });
    f.setProvider(async () => {
      entered();
      await new Promise(resolve => {
        release = resolve;
      });
      return new Response(JSON.stringify({ number: 17, title: 'Too late', body: '', state: 'open' }));
    });
    const stale = f.request();
    const running = s.readIssue(w, a, stale);
    const rejected = assert.rejects(running, /provider-failed/);
    await started;
    await f.owner.query(
      `UPDATE ${f.table('tf_integration_dispatches')} SET started_at = now() - interval '61 seconds' WHERE request_id = $1`,
      [stale.requestId],
    );
    await assert.rejects(s.readIssue(w, a, stale), /provider-failed/);
    release();
    await rejected;
    await assert.rejects(s.readIssue(w, a, stale), /provider-failed/);
    assert.equal(f.calls.length, 3);
  } finally {
    await f.close();
  }
});
