import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { AccessDenied } from '@tulipfarm/access';
import { createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { workspaceTableMigrations } from '../../workspaces/src/table-migrations.ts';
import { createWorkflows } from '../src/service.ts';
import { activate } from './commands.fixture.mjs';

const encodeBase64Url = value => Buffer.from(value, 'utf8').toString('base64url');

test(
  'a Gmail trigger verifies access on save/activate, fires once for a customer reply, ignores own sent mail, and deduplicates on repeated polls',
  { timeout: 120000 },
  async () => {
    const db = await fixture();
    let runtime;
    try {
      const w = await db.create(await workspaceTableMigrations());
      runtime = createWorkspaceRuntime({
        replicaCount: 1,
        reservedConnections: 2,
        databaseConnectionBudget: 20,
        resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(w) }),
      });

      const allowedIntegrationId = randomUUID();
      const deniedIntegrationId = randomUUID();
      let accessRevoked = false;

      const messages = new Map([
        [
          'msg-welcome-own',
          {
            id: 'msg-welcome-own',
            threadId: 'thread-welcome',
            internalDate: '1763000001000',
            snippet: 'Welcome to Example!',
            labelIds: ['SENT'],
            payload: {
              mimeType: 'text/plain',
              headers: [
                { name: 'From', value: 'Team <team@example.com>' },
                { name: 'To', value: 'customer@example.com' },
                { name: 'Subject', value: 'Welcome to Example' },
              ],
              body: { data: encodeBase64Url('Welcome to Example! Reply if you need anything.') },
            },
          },
        ],
        [
          'msg-customer-reply',
          {
            id: 'msg-customer-reply',
            threadId: 'thread-welcome',
            internalDate: '1763000020000',
            snippet: 'Thanks for the note!',
            labelIds: ['INBOX'],
            payload: {
              mimeType: 'text/plain',
              headers: [
                { name: 'From', value: 'Customer <customer@example.com>' },
                { name: 'To', value: 'Team <team@example.com>' },
                { name: 'Subject', value: 'Re: Welcome to Example' },
                { name: 'In-Reply-To', value: '<msg-welcome-own@example.com>' },
              ],
              body: { data: encodeBase64Url('Thanks! Can we schedule an onboarding call?') },
            },
          },
        ],
      ]);

      const gmailFetch = async input => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('/users/me/messages?')) {
          return new Response(
            JSON.stringify({
              messages: [
                { id: 'msg-customer-reply', threadId: 'thread-welcome' },
                { id: 'msg-welcome-own', threadId: 'thread-welcome' },
              ],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        const id = url.split('/users/me/messages/')[1]?.split('?')[0];
        return new Response(JSON.stringify(messages.get(id)), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      };

      const gmailAccess = {
        async verifyAccess(_tx, actor, integrationId) {
          if (accessRevoked || integrationId !== allowedIntegrationId || actor.membershipId !== w.membershipId) {
            throw new AccessDenied();
          }
          return { accountEmail: 'team@example.com' };
        },
        async withCredential(_workspaceId, actor, integrationId, operation) {
          if (accessRevoked || integrationId !== allowedIntegrationId || actor.membershipId !== w.membershipId) {
            throw new AccessDenied();
          }
          return operation({
            accessToken: 'fake-access-token',
            accountEmail: 'team@example.com',
            signal: new AbortController().signal,
          });
        },
      };

      const woken = [];
      const service = createWorkflows(runtime, {
        gmailAccess,
        gmailFetch,
        wake: async work => {
          woken.push(work);
        },
      });

      const workflowId = randomUUID();
      const revision = randomUUID();

      await assert.rejects(
        service.save(w.id, w.userId, workflowId, {
          revision,
          expectedRevision: null,
          definition: {
            version: 1,
            name: 'Denied Gmail trigger',
            triggers: [{ id: 'inbox', kind: 'gmail', integrationId: deniedIntegrationId }],
            steps: [{ id: 'copy', kind: 'transform', fields: { from: { kind: 'input', path: ['from'] } } }],
          },
        }),
        error => error instanceof AccessDenied,
      );

      await service.save(w.id, w.userId, workflowId, {
        revision,
        expectedRevision: null,
        definition: {
          version: 1,
          name: 'Customer reply handler',
          triggers: [
            {
              id: 'inbox',
              kind: 'gmail',
              integrationId: allowedIntegrationId,
              repliesOnly: true,
              excludeOwnSent: true,
            },
          ],
          steps: [
            {
              id: 'extract',
              kind: 'transform',
              fields: {
                sender: { kind: 'input', path: ['from'] },
                body: { kind: 'input', path: ['bodyText'] },
              },
            },
          ],
        },
      });

      await activate(service, w.id, w.userId, workflowId, revision, true);

      const firstPoll = await service.pollGmailTrigger(w.id, workflowId, 'inbox');
      assert.equal(firstPoll.polled, true);
      assert.equal(firstPoll.admitted.length, 1);
      assert.equal(firstPoll.deduplicated, 0);
      assert.equal(woken.length, 1);

      const detail = await service.runDetail(w.id, w.userId, workflowId, firstPoll.admitted[0]);
      assert.equal(detail.run.source, 'gmail');
      assert.equal(detail.run.input.messageId, 'msg-customer-reply');
      assert.equal(detail.run.input.from, 'Customer <customer@example.com>');
      assert.equal(detail.run.input.bodyText, 'Thanks! Can we schedule an onboarding call?');

      // Poll again with cursor reset to null to prove durable DB deduplication by messageId.
      const secondPoll = await service.pollGmailTrigger(w.id, workflowId, 'inbox', { cursor: null });
      assert.equal(secondPoll.polled, true);
      assert.equal(secondPoll.admitted.length, 0);
      assert.equal(secondPoll.deduplicated, 1);

      const runs = await service.history(w.id, w.userId, workflowId);
      assert.equal(runs.runs.length, 1);

      // Revoking sponsor access auto-disables the workflow on the next poll.
      accessRevoked = true;
      const revokedPoll = await service.pollGmailTrigger(w.id, workflowId, 'inbox');
      assert.equal(revokedPoll.polled, false);
      const listed = (await service.list(w.id, w.userId)).find(item => item.id === workflowId);
      assert.equal(listed?.enabled, false);
    } finally {
      await runtime?.close();
      await db.close();
    }
  },
);
