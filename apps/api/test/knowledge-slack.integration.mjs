import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createSlackMemberLinking } from '@tulipfarm/slack';
import { createWorkerSlackKnowledge } from '../../worker/dist/knowledge-slack-composition.js';
import { createSlackKnowledgeActivities } from '../../worker/dist/knowledge-slack-activities.js';
import { knowledgeFixture } from './knowledge-fixture.mjs';
import { slackProviderFixture } from './knowledge-slack-provider-fixture.mjs';

test('authenticated Slack corpus HTTP uses each member own linked Slack identity', { timeout: 180000 }, async t => {
  const slack = slackProviderFixture();
  let f;
  try {
    f = await knowledgeFixture({ slackCorpus: slack.provider });
    const owner = await slack.link(f, f.signed.owner, f.workspace.membershipId, 'UOWNER');
    const reader = await slack.link(f, f.signed.admin, f.adminMembership, 'UREADER');
    const worker = createWorkerSlackKnowledge({ runtime: f.runtime, slackCorpus: slack.provider(f.runtime) });
    const activity = createSlackKnowledgeActivities(worker);
    const readerOptions = { cookie: f.signed.admin.cookie };
    const configure = {
      commandId: randomUUID(),
      selection: { kind: 'channels', conversationIds: ['CGENERAL', 'GPRIVATE'], after: slack.after },
      memberIds: [f.adminMembership],
    };
    const sourceId = configure.commandId;
    // Search has a bounded deadline; retry only storage-deadline 503s so host load cannot masquerade as an authorization result.
    const search = async (options = {}, id = sourceId) => {
      for (let attempt = 0; ; attempt++) {
        const response = await f.call('/search', {
          ...options,
          method: 'POST',
          body: { kind: 'typing', query: 'orchid', filters: { kinds: ['slack'], sourceIds: [id] } },
        });
        if (response.status !== 503 || attempt >= 4) return response;
      }
    };
    async function processSource(id = sourceId) {
      for (let index = 0; index < 10; index++) {
        const work = (await worker.due(f.workspace.id)).find(item => item.sourceId === id);
        if (!work) return;
        assert.equal(await activity.processSlackKnowledge(work), undefined);
      }
      assert.fail('bounded fixture did not complete');
    }
    let ownerHits;
    await t.test('authentication, origin and input validation precede provider calls', async () => {
      const before = slack.calls.length;
      assert.equal((await f.call('/slack/discover?kind=channels', { cookie: '' })).status, 401);
      assert.equal(
        (
          await f.call('/slack/sources', {
            method: 'POST',
            body: configure,
            headers: { origin: 'https://untrusted.test' },
          })
        ).status,
        403,
      );
      assert.equal((await f.call('/slack/discover?kind=everything')).status, 400);
      assert.equal(
        (await f.call('/slack/sources', { method: 'POST', body: { ...configure, extra: true } })).status,
        400,
      );
      assert.equal(slack.calls.length, before);
      assert.equal((await f.call(`/v1/workspaces/${f.other.id}/knowledge/slack/sources`)).status, 404);
      const members = await f.call('/slack/members');
      assert.equal(members.status, 200, members.bytes.toString());
      assert.deepEqual(
        members
          .json()
          .members.map(member => member.id)
          .sort(),
        [f.workspace.membershipId, f.adminMembership].sort(),
      );
    });
    await t.test('discovery lists only conversations the caller belongs to', async () => {
      const channels = await f.call('/slack/discover?kind=channels');
      assert.equal(channels.status, 200, channels.bytes.toString());
      assert.deepEqual(
        channels.json().items.map(item => [item.conversationId, item.kind]),
        [
          ['CGENERAL', 'public'],
          ['GPRIVATE', 'private'],
        ],
      );
      assert.deepEqual(
        (await f.call('/slack/discover?kind=personal')).json().items.map(item => item.conversationId),
        ['DOWNER'],
      );
      assert.deepEqual(
        (await f.call('/slack/discover?kind=channels', readerOptions)).json().items.map(item => item.conversationId),
        ['CGENERAL'],
      );
      assert.ok(
        slack.calls
          .filter(call => call.method === 'users.conversations')
          .every(call => ['UOWNER', 'UREADER'].includes(call.user)),
      );
    });
    await t.test('setup, background sync, generic and Slack evidence, and safe Markdown download', async () => {
      const configured = await f.call('/slack/sources', { method: 'POST', body: configure });
      assert.equal(configured.status, 200, configured.bytes.toString());
      assert.equal(configured.json().canManage, true);
      assert.equal((await f.call('/slack/sources', { method: 'POST', body: configure })).json().sourceId, sourceId);
      await processSource();
      const listed = (await f.call('/slack/sources')).json().items[0];
      assert.equal(listed.syncState, 'ready');
      assert.deepEqual(listed.counts, { total: 2, ready: 2, failed: 0 });
      ownerHits = (await search()).json().hits;
      assert.equal(ownerHits.length, 2);
      for (const prefix of ['', '/slack']) {
        const evidence = await f.call(`${prefix}/evidence`, { method: 'POST', body: ownerHits[0].citation });
        assert.equal(evidence.status, 200, evidence.bytes.toString());
        assert.equal(evidence.json().original.kind, 'slack');
        const download = await f.call(
          `${prefix}/documents/${ownerHits[0].citation.documentId}/original?revisionId=${ownerHits[0].citation.revisionId}`,
        );
        assert.equal(download.status, 200);
        assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
        assert.match(
          download.headers.get('content-disposition'),
          /^attachment; filename="document"; filename\*=UTF-8''slack-thread\.md$/,
        );
        assert.match(download.bytes.toString(), /## (Message|Reply) by U[A-Z]+ at \d{4}-\d{2}-\d{2}T/);
      }
      const thread = ownerHits.find(hit => hit.title.startsWith('#general'));
      assert.ok(thread);
      const documents = await f.call(`/slack/sources/${sourceId}/documents`);
      assert.equal(documents.status, 200, documents.bytes.toString());
      assert.equal(documents.json().items.length, 2);
      assert.ok(documents.json().items.every(item => Date.parse(item.validUntil) <= Date.now() + 300000));
      assert.equal((await f.call(`/slack/documents/${thread.citation.documentId}`)).json().parsing, 'ready');
    });
    await t.test(
      'a selected reader sees only conversations they currently belong to, after their own check',
      async () => {
        const shared = (await f.call('/slack/sources', readerOptions)).json().items[0];
        assert.equal(shared.canManage, false);
        assert.equal(shared.selection, null);
        assert.equal(shared.conversations, null);
        const before = (await search(readerOptions)).json();
        assert.deepEqual(before.hits, []);
        assert.equal(before.coverage, 'partial');
        const refreshed = await f.call(`/slack/sources/${sourceId}/refresh`, { ...readerOptions, method: 'POST' });
        assert.equal(refreshed.status, 200, refreshed.bytes.toString());
        assert.deepEqual(refreshed.json(), { refreshed: 1, unavailable: 1, bounded: true });
        assert.ok(
          slack.calls
            .filter(call => call.method === 'conversations.info' && call.query.channel === 'GPRIVATE')
            .some(call => call.user === 'UREADER'),
        );
        const visible = (await search(readerOptions)).json().hits;
        assert.deepEqual(
          visible.map(hit => hit.title.split(' · ')[0]),
          ['#general'],
        );
        const privateHit = ownerHits.find(hit => hit.title.startsWith('#leadership'));
        assert.equal(
          (await f.call('/evidence', { ...readerOptions, method: 'POST', body: privateHit.citation })).status,
          404,
        );
        assert.equal(
          (
            await f.call(
              `/documents/${privateHit.citation.documentId}/original?revisionId=${privateHit.citation.revisionId}`,
              readerOptions,
            )
          ).status,
          404,
        );
        assert.equal(
          (
            await f.call(`/slack/sources/${sourceId}/manage`, {
              ...readerOptions,
              method: 'POST',
              body: { commandId: randomUUID(), action: 'pause' },
            })
          ).status,
          404,
        );
      },
    );
    await t.test('existing member unlinking and Slack-side removal revoke reader access', async () => {
      const linking = createSlackMemberLinking({
        runtime: f.runtime,
        config: { appId: slack.appId, clientId: 'fixture', clientSecret: 'fixture-secret' },
        cipher: slack.cipher,
        installations: { route: async () => null },
      });
      await linking.unlink(f.workspace.id, f.signed.admin.id);
      assert.deepEqual((await search(readerOptions)).json().hits, []);
      assert.equal((await f.call('/slack/discover?kind=channels', readerOptions)).json().error, 'slack-not-linked');
      assert.equal(
        (await f.call(`/slack/sources/${sourceId}/refresh`, { ...readerOptions, method: 'POST' })).status,
        404,
      );
      const credential = slack.cipher.encrypt(
        {
          workspaceId: f.workspace.id,
          installationId: slack.installationId,
          generation: 1,
          kind: 'user',
          identityId: reader.identityId,
          membershipId: f.adminMembership,
          slackUserId: 'UREADER',
        },
        reader.token,
      );
      await f.db.platform.query(
        `UPDATE ${f.table('tf_slack_identities')} SET state='authorized',credential=$2,authorized_at=clock_timestamp() WHERE id=$1`,
        [reader.identityId, credential],
      );
      assert.deepEqual(
        (await search(readerOptions)).json().hits,
        [],
        'relinking does not resurrect proofs from the old link',
      );
      await f.call(`/slack/sources/${sourceId}/refresh`, { ...readerOptions, method: 'POST' });
      assert.equal((await search(readerOptions)).json().hits.length, 1);
      slack.state.conversations.get('CGENERAL').members.delete('UREADER');
      assert.deepEqual(
        (await f.call(`/slack/sources/${sourceId}/refresh`, { ...readerOptions, method: 'POST' })).json(),
        { refreshed: 0, unavailable: 2, bounded: true },
      );
      assert.deepEqual((await search(readerOptions)).json().hits, []);
      slack.state.conversations.get('CGENERAL').members.add('UREADER');
    });
    await t.test('personal conversations stay owner-only and admins get no implicit access', async () => {
      const shared = await f.call('/slack/sources', {
        method: 'POST',
        body: {
          commandId: randomUUID(),
          selection: { kind: 'personal', conversationIds: ['DOWNER'], after: slack.after },
          memberIds: [f.adminMembership],
        },
      });
      assert.equal(shared.status, 404);
      const personalId = randomUUID();
      const personal = await f.call('/slack/sources', {
        method: 'POST',
        body: {
          commandId: personalId,
          selection: { kind: 'personal', conversationIds: ['DOWNER'], after: slack.after },
          memberIds: [],
        },
      });
      assert.equal(personal.status, 200, personal.bytes.toString());
      await processSource(personalId);
      assert.equal((await search({}, personalId)).json().hits.length, 1);
      assert.deepEqual((await search(readerOptions, personalId)).json().hits, []);
      assert.equal(
        (await f.call(`/slack/sources/${personalId}/refresh`, { ...readerOptions, method: 'POST' })).status,
        404,
      );
      assert.equal(
        (await f.call('/slack/sources', readerOptions)).json().items.some(item => item.sourceId === personalId),
        false,
      );
      const wrong = await f.call('/slack/sources', {
        method: 'POST',
        body: {
          commandId: randomUUID(),
          selection: { kind: 'channels', conversationIds: ['DOWNER'], after: slack.after },
          memberIds: [],
        },
      });
      assert.equal(wrong.json().error, 'slack-wrong-kind');
    });
    await t.test('provider rate limits and archived selections map to bounded errors', async () => {
      slack.state.failure = (user, method) =>
        user === 'UOWNER' && method === 'users.conversations'
          ? new Response('slow', { status: 429, headers: { 'retry-after': '3' } })
          : null;
      const limited = await f.call('/slack/discover?kind=channels');
      assert.equal(limited.status, 429);
      assert.equal(limited.json().error, 'slack-rate-limited');
      slack.state.failure = null;
      slack.state.conversations.get('GPRIVATE').archived = true;
      const archived = await f.call('/slack/sources', {
        method: 'POST',
        body: {
          commandId: randomUUID(),
          selection: { kind: 'channels', conversationIds: ['GPRIVATE'], after: slack.after },
          memberIds: [],
        },
      });
      assert.equal(archived.status, 409);
      assert.equal(archived.json().error, 'slack-archived');
      slack.state.conversations.get('GPRIVATE').archived = false;
      assert.equal(owner.identityId.length, 36);
    });
    await t.test(
      'a replies page that advertises more without a cursor cannot replace the published thread',
      async () => {
        const general = slack.state.threads.get('CGENERAL')[0];
        const { replies: earlier, ...root } = general;
        const at = seconds => `${Number(slack.root.split('.')[0]) + seconds}.000300`;
        const added = [
          { ts: at(120), thread_ts: slack.root, user: 'UOWNER', text: 'Lilac substitution approved' },
          { ts: at(180), thread_ts: slack.root, user: 'UREADER', text: 'Final orchid invoice sent' },
        ];
        general.reply_count = 3;
        general.replies = [...earlier, ...added];
        const firstPage = { ok: true, messages: [root, ...earlier, added[0]], has_more: true };
        const replies = page => (_user, method, query) =>
          method === 'conversations.replies' && query.channel === 'CGENERAL' ? Response.json(page(query)) : null;
        const sync = async () => {
          await f.db.platform.query(
            `UPDATE ${f.table('tf_knowledge_slack_sources')} SET next_attempt_at=clock_timestamp() WHERE source_id=$1`,
            [sourceId],
          );
          await processSource();
          const listed = (await f.call('/slack/sources')).json().items.find(item => item.sourceId === sourceId);
          const hit = (await search()).json().hits.find(item => item.title.startsWith('#general'));
          const markdown = (
            await f.call(`/documents/${hit.citation.documentId}/original?revisionId=${hit.citation.revisionId}`)
          ).bytes.toString();
          return {
            state: [listed.syncState, listed.failure],
            citation: hit.citation,
            replies: [...markdown.matchAll(/^## Reply by (U[A-Z]+)/gm)].map(match => match[1]),
          };
        };
        const published = (await search()).json().hits.find(item => item.title.startsWith('#general')).citation;
        try {
          slack.state.failure = replies(() => ({ ...firstPage, response_metadata: { next_cursor: '' } }));
          assert.deepEqual(await sync(), {
            state: ['failed', 'invalid-response'],
            citation: published,
            replies: ['UREADER'],
          });
          slack.state.failure = replies(query =>
            query.cursor === 'replies-2'
              ? { ok: true, messages: [added[1]], has_more: false, response_metadata: { next_cursor: '' } }
              : { ...firstPage, response_metadata: { next_cursor: 'replies-2' } },
          );
          const complete = await sync();
          assert.deepEqual(complete.state, ['ready', null]);
          assert.equal(complete.citation.documentId, published.documentId);
          assert.notEqual(complete.citation.revisionId, published.revisionId);
          assert.deepEqual(complete.replies, ['UREADER', 'UOWNER', 'UREADER']);
        } finally {
          slack.state.failure = null;
        }
      },
    );
    await t.test(
      'bot answers in a selected conversation never reach search, evidence or download while human messages stay searchable',
      async () => {
        const base = Number(slack.root.split('.')[0]);
        const [general] = slack.state.threads.get('CGENERAL');
        general.reply_count += 1;
        general.replies.push({
          ts: `${base + 150}.000300`,
          thread_ts: slack.root,
          user: 'UBOT',
          bot_id: 'BTULIPFARM',
          app_id: slack.appId,
          text: 'Orchid renewal price from the protected contract is 48250 per crate',
        });
        slack.state.threads.get('CGENERAL').push({
          ts: `${base + 180}.000400`,
          subtype: 'bot_message',
          bot_id: 'BALERTS',
          username: 'alerts',
          text: 'Orchid shipment 7731 escalated to legal',
        });
        await f.db.platform.query(
          `UPDATE ${f.table('tf_knowledge_slack_sources')} SET next_attempt_at=clock_timestamp() WHERE source_id=$1`,
          [sourceId],
        );
        await processSource();
        const find = async query => {
          for (let attempt = 0; ; attempt++) {
            const response = await f.call('/search', {
              method: 'POST',
              body: { kind: 'typing', query, filters: { kinds: ['slack'], sourceIds: [sourceId] } },
            });
            if (response.status !== 503 || attempt >= 4) {
              assert.equal(response.status, 200, response.bytes.toString());
              return response.json().hits;
            }
          }
        };
        assert.deepEqual(await find('48250'), []);
        assert.deepEqual(await find('escalated legal'), []);
        const thread = (await find('confirmed orchid quantities')).find(hit => hit.title.startsWith('#general'));
        assert.ok(thread, 'the human reply in the same thread stays searchable');
        const evidence = await f.call('/slack/evidence', { method: 'POST', body: thread.citation });
        assert.equal(evidence.status, 200, evidence.bytes.toString());
        assert.doesNotMatch(evidence.json().text, /48250/);
        const download = await f.call(
          `/slack/documents/${thread.citation.documentId}/original?revisionId=${thread.citation.revisionId}`,
        );
        assert.equal(download.status, 200);
        const markdown = download.bytes.toString();
        assert.doesNotMatch(markdown, /48250|protected contract/);
        assert.match(markdown, /^Confirmed orchid quantities$/m);
        assert.match(
          markdown,
          /^## Reply by UBOT at \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\n\n_Bot message withheld from Knowledge\._$/m,
        );
      },
    );
  } finally {
    await f?.close();
  }
});
