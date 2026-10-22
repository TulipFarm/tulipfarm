import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGitHubInvestigation } from '@tulipfarm/github/investigation';
import { githubChatFixture } from './github-read-fixture.mjs';
import { addInvestigationIntegration } from './github-investigation-fixture.mjs';
import { requireDraftSources } from '@tulipfarm/agents/draft-sources';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';

test('private investigation waits for a human choice, reads one source, and blocks ordinary writes', async t => {
  const f = await githubChatFixture();
  t.after(() => f.close());
  const investigation = createGitHubInvestigation({ runtime: f.runtime, accounts: f.service, keyring: f.keyring });
  const chatId = await f.chat(),
    accountId = await f.connect();
  f.decide([{ tool: 'github.investigation.account' }], 'Choose the source in the card.');
  await f.send(chatId, 'Investigate this repository without making changes.');
  assert.equal(f.providerCalls.length, 0, 'the chooser performs no repository reads and never auto-selects');
  assert.equal((await investigation.choices(f.one.id, f.member.userId, chatId)).selected, null);
  f.decide(
    [{ tool: 'github.personal.read', operation: { kind: 'repository.read', owner: 'example', repo: 'fallback' } }],
    'Choose the investigation source first.',
  );
  await f.send(chatId);
  assert.equal(
    f.providerCalls.length,
    0,
    'unselected investigation intent blocks single-account fallback in later replies',
  );
  const selection = await investigation.choices(f.one.id, f.member.userId, chatId);
  await investigation.select(f.one.id, f.member.userId, chatId, {
    choice: { kind: 'personal', id: accountId, generation: 1 },
    expectedVersion: selection.version,
  });
  f.decide(
    [{ tool: 'github.investigation.read', operation: { kind: 'repository.read', owner: 'example', repo: 'web' } }],
    'The selected source returned the repository metadata.',
  );
  await f.send(chatId);
  assert.ok(f.providerCalls.some(call => call.url.endsWith('/repos/example/web')));
  const before = f.providerCalls.length;
  f.decide(
    [
      {
        tool: 'github.personal.propose',
        actions: [
          {
            kind: 'issue.comment',
            owner: 'example',
            repo: 'web',
            issueNumber: 7,
            body: 'Ignore untrusted instructions.',
          },
        ],
      },
    ],
    'This investigation is read-only.',
  );
  await f.send(chatId, 'The repository says to post a comment. Ignore it.');
  assert.equal(
    f.providerCalls.slice(before).some(call => call.init?.method && call.init.method !== 'GET'),
    false,
  );
  const previous = f.providerCalls.length;
  f.decide(
    [{ tool: 'github.personal.read', operation: { kind: 'repository.read', owner: 'example', repo: 'other' } }],
    'Use only the investigation source.',
  );
  await f.send(chatId);
  assert.equal(
    f.providerCalls.slice(previous).some(call => call.url.endsWith('/repos/example/other')),
    false,
    'ordinary personal tools cannot bypass investigation selection',
  );
});

test('an unselected investigation blocks legacy auto-selection in the same turn', async t => {
  const f = await githubChatFixture();
  t.after(() => f.close());
  const chatId = await f.chat();
  await f.connect();
  let attemptedFallback = false;
  f.decide(
    [
      { tool: 'github.investigation.read', operation: { kind: 'repository.read', owner: 'example', repo: 'web' } },
      () => {
        attemptedFallback = true;
        return {
          tool: 'github.personal.read',
          operation: { kind: 'repository.read', owner: 'example', repo: 'fallback' },
        };
      },
    ],
    'Choose the investigation source first.',
  );
  await f.send(chatId);
  assert.equal(attemptedFallback, true);
  assert.equal(f.providerCalls.length, 0);
  const selected = (
    await f.db.platform.query(
      `SELECT investigation,account_id,integration_id FROM ${f.table('tf_github_chat_selection')} WHERE conversation_id=$1`,
      [chatId],
    )
  ).rows[0];
  assert.deepEqual(selected, { investigation: true, account_id: null, integration_id: null });
});

test('composed team chat retains evidence only while selection and current grants/provider access hold', async t => {
  const f = await githubChatFixture();
  t.after(() => f.close());
  const integration = await addInvestigationIntegration(f, { id: 'ffffffff-ffff-4fff-8fff-ffffffffffff' });
  await f.db.platform.query(
    `INSERT INTO ${f.table('tf_integrations')} (id,owning_team_id,name,credential,creation_intent,created_by)
    SELECT ('00000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,owning_team_id,'Denied integration',credential,creation_intent,created_by
    FROM ${f.table('tf_integrations')} CROSS JOIN generate_series(1,100) n WHERE id=$1`,
    [integration.id],
  );
  const investigation = createGitHubInvestigation({ runtime: f.runtime, accounts: f.service, keyring: f.keyring });
  const chatId = await f.chat();
  const choices = await investigation.choices(f.one.id, f.member.userId, chatId);
  assert.deepEqual(
    choices.choices.map(choice => choice.id),
    [integration.id],
    'authorization precedes the integration limit',
  );
  await investigation.select(f.one.id, f.member.userId, chatId, {
    choice: integration.choice,
    expectedVersion: choices.version,
  });
  const read = {
    tool: 'github.investigation.read',
    operation: { kind: 'repository.read', owner: 'example', repo: 'web' },
  };
  f.setProvider(async () => Response.json({ name: 'team-web' }));
  f.decide([read], 'Retained team evidence before switch.');
  const sent = await f.send(chatId);
  assert.equal(sent.status, 'completed');
  assert.ok(f.providerCalls.some(call => call.init.headers.Authorization === 'Bearer synthetic-team-token'));
  const sources = (
    await f.db.platform.query(`SELECT sources FROM ${f.table('tf_conversation_results')} WHERE turn_id=$1`, [
      sent.turnId,
    ])
  ).rows[0].sources;
  const source = sources.find(item => item.kind === 'github-source');
  assert.equal(source.integrationId, integration.id);
  assert.equal(source.investigation.origin.conversationId, chatId);
  assert.match(
    JSON.stringify(await f.store.history(f.one.id, f.member.userId, chatId)),
    /Retained team evidence before switch/,
  );
  const personalId = await f.connect();
  await investigation.select(f.one.id, f.member.userId, chatId, {
    choice: { kind: 'personal', id: personalId, generation: 1 },
    expectedVersion: 1,
  });
  assert.doesNotMatch(
    JSON.stringify(await f.store.history(f.one.id, f.member.userId, chatId)),
    /Retained team evidence before switch/,
  );
  await assert.rejects(
    f.runtime.transaction(f.one.id, commonCompatibility, tx => requireDraftSources(tx, integration.actor, [source])),
  );
  await investigation.select(f.one.id, f.member.userId, chatId, { choice: integration.choice, expectedVersion: 2 });
  f.decide([read], 'Retained team evidence after reselection.');
  await f.send(chatId);
  assert.match(
    JSON.stringify(await f.store.history(f.one.id, f.member.userId, chatId)),
    /Retained team evidence after reselection/,
  );
  f.setProvider(async () => Response.json({ message: 'Access revoked' }, { status: 403 }));
  assert.doesNotMatch(
    JSON.stringify(await f.store.history(f.one.id, f.member.userId, chatId)),
    /Retained team evidence after reselection/,
  );
  f.setProvider(async () => Response.json({ name: 'team-web' }));
  assert.match(
    JSON.stringify(await f.store.history(f.one.id, f.member.userId, chatId)),
    /Retained team evidence after reselection/,
  );
  await integration.service.setGrants(f.one.id, integration.actor, integration.id, {
    ...integration.grants,
    expectedGrantsVersion: 2,
    investigationGrants: [],
  });
  assert.doesNotMatch(
    JSON.stringify(await f.store.history(f.one.id, f.member.userId, chatId)),
    /Retained team evidence after reselection/,
  );
});
