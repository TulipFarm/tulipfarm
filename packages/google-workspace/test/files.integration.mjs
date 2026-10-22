import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { AccessDenied } from '@tulipfarm/access';
import { googleFixture } from './fixture.mjs';
import { createGoogleOperations } from '../src/operations.ts';

const metadata = { id: 'file-1', name: 'Report', mimeType: 'application/pdf' };
const binding = value => ({
  integrationId: value.integrationId,
  accountId: value.accountId,
  generation: value.generation,
});
test('Files requires its app scope, refresh failures require reconnect, and its own deadline cancels content', async () => {
  const f = await googleFixture();
  try {
    f.behavior({
      scopes: ['openid', 'https://www.googleapis.com/auth/userinfo.email', 'https://www.googleapis.com/auth/documents'],
    });
    let connected = await f.connect();
    let cancelled = false;
    const operations = createGoogleOperations({
      runtime: f.runtime,
      integrations: f.service,
      fetcher: async url =>
        url.searchParams.has('fields')
          ? Response.json(metadata)
          : new Response(
              new ReadableStream({
                cancel() {
                  cancelled = true;
                },
              }),
            ),
    });
    const input = () => ({ fileId: 'file-1', kind: 'download', expectedIntegration: binding(connected) });
    await assert.rejects(operations.fileContent(f.workspace.id, f.member.userId, input()), /insufficient-scope/);
    f.behavior({});
    connected = await f.connect();
    await assert.rejects(operations.fileContent(f.workspace.id, f.member.userId, input()), /transfer-timeout/);
    assert.equal(cancelled, true);
    f.advance(3_600_000);
    f.behavior({ refreshError: 'invalid_grant' });
    await assert.rejects(operations.fileContent(f.workspace.id, f.member.userId, input()), /reconnect-required/);
    assert.equal((await f.service.status(f.workspace.id, f.member.userId)).status, 'reconnect-required');
  } finally {
    await f.close();
  }
});
test('file reads bind owner and account generation and recheck after the provider completes', async () => {
  const f = await googleFixture();
  try {
    let provider = async url =>
      url.searchParams.has('fields') ? Response.json(metadata) : new Response('private PDF');
    const operations = createGoogleOperations({
      runtime: f.runtime,
      integrations: f.service,
      fetcher: (...args) => provider(...args),
    });
    let connected = await f.connect();
    const input = () => ({ fileId: 'file-1', kind: 'download', expectedIntegration: binding(connected) });
    assert.equal(
      Buffer.from((await operations.fileContent(f.workspace.id, f.member.userId, input())).bytes).toString(),
      'private PDF',
    );
    for (const change of [
      { integrationId: randomUUID() },
      { accountId: 'other' },
      { generation: connected.generation + 1 },
    ]) {
      await assert.rejects(
        operations.fileContent(f.workspace.id, f.member.userId, {
          ...input(),
          expectedIntegration: { ...binding(connected), ...change },
        }),
        /reconnect-required/,
      );
    }
    await assert.rejects(operations.fileContent(f.workspace.id, f.admin.userId, input()), /integration-required/);
    for (const change of ['disconnect', 'account', 'generation', 'scope', 'membership']) {
      const entered = Promise.withResolvers(),
        release = Promise.withResolvers();
      provider = async url => {
        if (url.searchParams.has('fields')) return Response.json(metadata);
        entered.resolve();
        await release.promise;
        return new Response('must not escape');
      };
      const reading = operations.fileContent(f.workspace.id, f.member.userId, input());
      const rejected = assert.rejects(
        reading,
        change === 'membership' ? AccessDenied : /stale-integration|insufficient-scope|reconnect-required/,
      );
      await entered.promise;
      try {
        if (change === 'disconnect') await f.service.disconnect(f.workspace.id, f.member.userId);
        if (change === 'account') {
          f.behavior({ account: 'google-account-2' });
          await f.connect();
        }
        if (change === 'generation')
          await f.db.platform.query(
            `UPDATE ${f.table('tf_google_integrations')} SET generation=generation+1 WHERE membership_id=$1`,
            [f.member.membershipId],
          );
        if (change === 'scope')
          await f.db.platform.query(
            `UPDATE ${f.table('tf_google_integrations')} SET scopes='{}' WHERE membership_id=$1`,
            [f.member.membershipId],
          );
        if (change === 'membership')
          await f.db.platform.query(
            `UPDATE ${f.table('tf_memberships')} SET removed_at=clock_timestamp() WHERE id=$1`,
            [f.member.membershipId],
          );
      } finally {
        release.resolve();
      }
      await rejected;
      if (change !== 'membership') {
        await f.service.disconnect(f.workspace.id, f.member.userId);
        f.behavior({});
        connected = await f.connect();
      }
    }
  } finally {
    await f.close();
  }
});

test('file read capacity is bounded per integration and a cancelled read releases its slot', async () => {
  const f = await googleFixture();
  const release = Promise.withResolvers();
  try {
    const connected = await f.connect();
    const other = await f.connect({ userId: f.admin.userId, sessionId: randomUUID() });
    const entered = Promise.withResolvers();
    let count = 0;
    const operations = createGoogleOperations({
      runtime: f.runtime,
      integrations: f.service,
      fetcher: async (_url, init) => {
        if (++count === 3) entered.resolve();
        if (count > 3) return Response.json({ files: [] });
        await Promise.race([
          release.promise,
          new Promise(resolve => init.signal.addEventListener('abort', resolve, { once: true })),
        ]);
        return Response.json({ files: [] });
      },
    });
    const controllers = Array.from({ length: 3 }, () => new AbortController());
    const reads = controllers.map(controller =>
      operations.listFiles(
        f.workspace.id,
        f.member.userId,
        { expectedIntegration: binding(connected) },
        controller.signal,
      ),
    );
    const results = Promise.allSettled(reads);
    await entered.promise;
    await assert.rejects(
      operations.listFiles(f.workspace.id, f.member.userId, { expectedIntegration: binding(connected) }),
      /transfer-busy/,
    );
    assert.deepEqual(
      await operations.listFiles(f.workspace.id, f.admin.userId, { expectedIntegration: binding(other) }),
      { files: [], incompleteSearch: false, skipped: 0 },
      "another member's integration keeps reading while this one is full",
    );
    controllers[0].abort();
    await assert.rejects(reads[0], /cancelled/);
    release.resolve();
    const outcomes = await results;
    assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 2);
    assert.deepEqual(
      await operations.listFiles(f.workspace.id, f.member.userId, { expectedIntegration: binding(connected) }),
      { files: [], incompleteSearch: false, skipped: 0 },
    );
  } finally {
    release.resolve();
    await f.close();
  }
});
