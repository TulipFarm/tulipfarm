import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createGoogleOperations, GoogleLifecycleError } from '../src/operations.ts';
import { googleFixture } from './fixture.mjs';

test('executeAutonomous sends allowlisted Gmail message on shared account, denies blocked recipients, and replays idempotently', async () => {
  const f = await googleFixture();
  try {
    const bob = { userId: randomUUID(), membershipId: randomUUID() };
    await f.db.platform.query(`INSERT INTO ${f.table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
      bob.membershipId,
      bob.userId,
    ]);

    f.behavior({ account: 'team-shared-sub', email: 'team@example.com' });
    const shared = await f.connect(f.principal, undefined, { ownership: 'shared', label: 'Team Inbox' });
    await f.service.setGrants(f.workspace.id, f.member.userId, shared.integrationId, {
      expectedGrantsVersion: 1,
      grants: [
        { kind: 'member', membershipId: f.member.membershipId, role: 'manage' },
        { kind: 'member', membershipId: bob.membershipId, role: 'use' },
      ],
    });

    const providerRequests = [];
    const operations = createGoogleOperations({
      runtime: f.runtime,
      integrations: f.service,
      fetcher: async (url, init) => {
        providerRequests.push({ url: String(url), method: init?.method ?? 'GET' });
        if (String(url).includes('/gmail/v1/users/me/messages/send')) {
          return Response.json({ id: 'sent-auto-1', threadId: 'thread-auto-1' });
        }
        throw new Error(`unexpected provider URL: ${url}`);
      },
    });

    const policy = {
      allowedOperations: ['gmail.messages.send'],
      allowedRecipients: ['verify@example.com'],
    };

    const blockedCommandId = randomUUID();
    await assert.rejects(
      operations.executeAutonomous(f.workspace.id, bob.userId, {
        commandId: blockedCommandId,
        integrationId: shared.integrationId,
        operation: {
          kind: 'gmail.messages.send',
          message: { to: ['customer@other.com'], subject: 'Blocked', body: 'Should not send' },
        },
        policy,
      }),
      error => error instanceof GoogleLifecycleError && error.code === 'operation-policy-denied',
    );
    assert.equal(providerRequests.length, 0);

    await assert.rejects(
      operations.executeAutonomous(f.workspace.id, bob.userId, {
        commandId: randomUUID(),
        integrationId: shared.integrationId,
        operation: {
          kind: 'calendar.events.create',
          calendarId: 'primary',
          event: {
            summary: 'Disallowed',
            start: { dateTime: '2026-05-01T15:00:00Z' },
            end: { dateTime: '2026-05-01T15:30:00Z' },
          },
        },
        policy,
      }),
      error => error instanceof GoogleLifecycleError && error.code === 'operation-policy-denied',
    );
    assert.equal(providerRequests.length, 0);

    const commandId = randomUUID();
    const allowedOp = {
      kind: 'gmail.messages.send',
      message: { to: ['verify@example.com'], subject: 'Hello', body: 'Autonomous send' },
    };

    const first = await operations.executeAutonomous(f.workspace.id, bob.userId, {
      commandId,
      integrationId: shared.integrationId,
      operation: allowedOp,
      policy,
    });
    assert.equal(first.receipt.status, 'succeeded');
    assert.equal(first.receipt.result.data.id, 'sent-auto-1');
    assert.equal(providerRequests.length, 1);

    const receiptRows = await f.db.platform.query(
      `SELECT status FROM ${f.table('tf_google_receipts')} WHERE proposal_id = $1`,
      [first.proposalId],
    );
    assert.equal(receiptRows.rows.length, 1);
    assert.equal(receiptRows.rows[0].status, 'succeeded');

    const replay = await operations.executeAutonomous(f.workspace.id, bob.userId, {
      commandId,
      integrationId: shared.integrationId,
      operation: allowedOp,
      policy,
    });
    assert.equal(replay.proposalId, first.proposalId);
    assert.equal(replay.receipt.status, 'succeeded');
    assert.equal(replay.receipt.result.data.id, 'sent-auto-1');
    assert.equal(providerRequests.length, 1);
  } finally {
    await f.close();
  }
});
