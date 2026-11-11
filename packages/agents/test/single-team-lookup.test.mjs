import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inferWithTools } from '../src/inference.ts';
import { runtimeReminder } from '../src/prompts.ts';
import * as directoryChecks from '../src/workspace-directory.ts';
import {
  azureStreamReply,
  isCompletionRequest,
  nativeReply,
  nativeRoutes,
  selectReply,
  use,
} from './native-fixture.mjs';

const directory = {
  scope: 'workspace',
  memberCount: 2,
  members: [{ name: 'Sam' }, { name: 'Lee' }],
  teamCount: 2,
  teams: [
    { name: 'Operations', peopleCount: 1, people: [{ name: 'Sam', role: 'manager' }] },
    { name: 'Finance', people: 'not-visible' },
  ],
  truncated: false,
};
const inventory = {
  visibility: 'requester-readable',
  complete: true,
  tables: [],
  agents: [],
  workflows: [],
  skills: [],
  directoryNames: { members: ['Sam', 'Lee'], teams: ['Operations', 'Finance'] },
};
const check = (workspaceDirectory, status = 'continue') =>
  selectReply('azure', { status, reason: 'Use the authorized directory evidence.', workspaceDirectory });
const { directoryAnswer, directoryNameMatches, directoryUnavailableReply } = directoryChecks;

for (const model of ['grok-4.3', 'DeepSeek-V4-Pro', 'Kimi-K2.6'])
  for (const question of ['Who is on team Operations?', 'Who manages the Operations team?'])
    test(`${model} answers a named team from a successful lookup after an unsupported rewrite: ${question}`, async t => {
      for (let run = 0; run < 5; run++) {
        let rounds = 0;
        const calls = [];
        const previews = [];
        t.mock.method(globalThis, 'fetch', async (_url, init) => {
          const body = JSON.parse(init.body);
          if (isCompletionRequest(body)) return Response.json(check(calls.length ? 'unsupported' : 'lookup-required'));
          assert.ok(rounds < 4, 'one read and one rewrite are enough');
          return azureStreamReply(
            nativeReply(
              'azure',
              rounds++ === 1
                ? { calls: [use('members.find')] }
                : { text: "I couldn't check the team. Please call members.find." },
            ),
          );
        });
        const result = await inferWithTools(
          { ...nativeRoutes.azure, model },
          [{ role: 'user', text: question }],
          async call => {
            calls.push(call);
            return directory;
          },
          undefined,
          false,
          null,
          {
            readWorkspaceInventory: async () => inventory,
            answerText: update => previews.push(update.text),
          },
        );
        assert.deepEqual(calls, [{ tool: 'members.find' }]);
        assert.equal(result.text, '- Operations: Sam (manager)');
        assert.ok(previews.every(text => !text.includes('members.find') && !text.includes("couldn't check")));
        t.mock.restoreAll();
      }
    });

for (const question of ['Does Operations have a manager?', 'Is Sam part of this workspace?'])
  test(`trusted whole names admit a missed directory request: ${question}`, async t => {
    let checks = 0;
    let lookups = 0;
    t.mock.method(globalThis, 'fetch', async (_url, init) => {
      if (isCompletionRequest(JSON.parse(init.body))) {
        checks++;
        return Response.json(check(lookups ? 'grounded' : 'lookup-required', lookups ? 'completed' : 'continue'));
      }
      return Response.json(
        nativeReply('azure', { text: lookups ? 'Sam is the Operations manager.' : 'I am not sure.' }),
      );
    });
    const result = await inferWithTools(
      nativeRoutes.azure,
      [{ role: 'user', text: question }],
      async () => {
        lookups++;
        return directory;
      },
      undefined,
      false,
      null,
      { readWorkspaceInventory: async () => inventory },
    );
    assert.equal(lookups, 1);
    assert.equal(checks, 2);
    assert.equal(result.text, 'Sam is the Operations manager.');
    for (const text of [
      'Write a note to Operations.',
      'If Sam had three apples, how many would remain after eating one?',
    ]) {
      let requests = 0;
      t.mock.method(globalThis, 'fetch', async (_url, init) => {
        requests++;
        return Response.json(
          isCompletionRequest(JSON.parse(init.body))
            ? check('not-applicable', 'completed')
            : nativeReply('azure', { text: 'Here is the answer.' }),
        );
      });
      const ordinary = await inferWithTools(
        nativeRoutes.azure,
        [{ role: 'user', text }],
        () => assert.fail('A name match is not authority to run a directory lookup'),
        undefined,
        false,
        null,
        { readWorkspaceInventory: async () => inventory },
      );
      assert.equal(ordinary.text, 'Here is the answer.');
      assert.equal(requests, 2);
    }
  });

test('an internal tool leak admits a missed directory request without inventory', async t => {
  let lookups = 0;
  let checks = 0;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    if (isCompletionRequest(JSON.parse(init.body))) {
      checks++;
      return Response.json(check(lookups ? 'grounded' : 'lookup-required', lookups ? 'completed' : 'continue'));
    }
    return Response.json(
      nativeReply('azure', {
        text: lookups ? 'Sam manages Operations.' : 'Use tools_search to find the people lookup.',
      }),
    );
  });
  const result = await inferWithTools(
    nativeRoutes.azure,
    [{ role: 'user', text: 'Does the Operations group have a manager?' }],
    async () => {
      lookups++;
      return directory;
    },
  );
  assert.equal(lookups, 1);
  assert.equal(checks, 2);
  assert.equal(result.text, 'Sam manages Operations.');
});

test('a successful filtered lookup is preserved when a rewrite remains unsupported', async t => {
  let rounds = 0;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    if (isCompletionRequest(JSON.parse(init.body))) return Response.json(check('unsupported'));
    return Response.json(
      nativeReply(
        'azure',
        rounds++ === 0 ? { calls: [use('members.find', { query: 'Finance' })] } : { text: "I couldn't check Finance." },
      ),
    );
  });
  const calls = [];
  const result = await inferWithTools(
    nativeRoutes.azure,
    [{ role: 'user', text: 'Who is on the Finance team?' }],
    async call => {
      calls.push(call);
      return {
        ...directory,
        scope: 'filtered',
        memberCount: 0,
        members: [],
        teamCount: 1,
        teams: [directory.teams[1]],
      };
    },
  );
  assert.deepEqual(calls, [{ tool: 'members.find', query: 'Finance' }]);
  assert.equal(result.text, "- Finance: I can't see this team's members.");
  assert.equal(
    directoryAnswer(
      { ...directory, teams: [{ ...directory.teams[0], peopleTruncated: true }], teamCount: 1 },
      'Who is on team Operations?',
    ),
    '- Operations: Sam (manager) More members are not shown.',
  );
  const failed = await inferWithTools(
    nativeRoutes.azure,
    [{ role: 'user', text: 'Who is on the Operations team?' }],
    async () => ({ error: 'tool-failed' }),
  );
  assert.equal(failed.text, directoryUnavailableReply);
});

test('a missing named team is checked and the real team list replaces unsupported model claims', async t => {
  let rounds = 0;
  let lookups = 0;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    if (isCompletionRequest(JSON.parse(init.body)))
      return Response.json(check(lookups ? 'unsupported' : 'lookup-required'));
    assert.ok(rounds++ < 4);
    return Response.json(nativeReply('azure', { text: 'The Shipping team has five people.' }));
  });
  const result = await inferWithTools(
    nativeRoutes.azure,
    [{ role: 'user', text: 'Who is on team Shipping?' }],
    async () => {
      lookups++;
      return directory;
    },
  );
  assert.equal(lookups, 1);
  assert.ok(result.text.startsWith('I couldn\'t find a team called "Shipping" in this workspace.'));
  assert.match(result.text, /Operations: Sam \(manager\)/);
  assert.match(result.text, /Finance: I can't see this team's members/);
  assert.doesNotMatch(result.text, /five|couldn't check|members\.find/);
  const unclean = `Shipping\u0000\u202e${'x'.repeat(100)}`;
  const sanitized = directoryAnswer(directory, `Who is on team ${unclean}?`);
  assert.ok(sanitized.startsWith(`I couldn't find a team called "${`Shipping${'x'.repeat(100)}`.slice(0, 80)}"`));
  assert.doesNotMatch(sanitized.replaceAll('\n', ''), /[\p{Cc}\p{Cf}]/u);
  for (const limited of [
    { ...directory, truncated: true },
    { ...directory, scope: 'filtered' },
  ])
    assert.doesNotMatch(directoryAnswer(limited, 'Who is on team Shipping?'), /couldn't find|couldn't check/);
});

test('directory names stay out of the model prompt and match only bounded whole names', async t => {
  const reminder = runtimeReminder({
    kind: 'tools',
    inventory: { ...inventory, directoryNames: { members: ['Private person'], teams: ['Private team'] } },
  });
  assert.doesNotMatch(reminder, /directoryNames|Private person|Private team/);
  assert.match(reminder, /workspaceInventory/);
  assert.deepEqual(directoryNameMatches('Operations East and Sam', ['Operations', 'Operations East', 'Sam']), [
    'Operations East',
    'Sam',
  ]);
  assert.deepEqual(
    directoryNameMatches('Samuel and PreOperations and Operations-East and \u{10400}Sam', ['Sam', 'Operations']),
    [],
  );
  assert.deepEqual(
    directoryNameMatches(
      'Operations',
      Array.from({ length: 101 }, () => 'Operations'),
    ),
    [],
  );
  for (const [text, names] of [
    ['Tell me about Samuel.', inventory.directoryNames],
    ['Hello.', inventory.directoryNames],
    ['Tell me about Operations.', { members: [], teams: Array.from({ length: 101 }, () => 'Operations') }],
  ]) {
    let requests = 0;
    t.mock.method(globalThis, 'fetch', async (_url, init) => {
      requests++;
      assert.equal(isCompletionRequest(JSON.parse(init.body)), false, 'unrelated replies need no checker');
      return Response.json(nativeReply('azure', { text: 'Here is the answer.' }));
    });
    await inferWithTools(
      nativeRoutes.azure,
      [{ role: 'user', text }],
      () => assert.fail('No lookup is needed'),
      undefined,
      false,
      null,
      { readWorkspaceInventory: async () => ({ ...inventory, directoryNames: names }) },
    );
    assert.equal(requests, 1);
  }
});

test('a checker failure on whole-name admission fails open once and records why', async t => {
  let requests = 0;
  const logs = [];
  const write = process.stdout.write.bind(process.stdout);
  t.mock.method(process.stdout, 'write', (chunk, ...args) => {
    if (typeof chunk === 'string' && chunk.startsWith('{"level":')) {
      logs.push(JSON.parse(chunk));
      return true;
    }
    return write(chunk, ...args);
  });
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    requests++;
    return isCompletionRequest(JSON.parse(init.body))
      ? Response.json({ error: { code: 'invalid_request' } }, { status: 400 })
      : Response.json(nativeReply('azure', { text: 'Operations can be a department name.' }));
  });
  const result = await inferWithTools(
    nativeRoutes.azure,
    [{ role: 'user', text: 'Tell me about the word Operations.' }],
    () => assert.fail('A failed admission check must not invent a directory request'),
    undefined,
    false,
    null,
    { readWorkspaceInventory: async () => inventory },
  );
  assert.equal(requests, 2);
  assert.equal(result.text, 'Operations can be a department name.');
  assert.ok(logs.some(log => log.operation === 'chat.directory-admission' && log.outcome === 'checker-unavailable'));
});
