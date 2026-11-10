import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { preparePastedImport } from '@tulipfarm/tables/imports';
import { inferWithTools } from '../src/inference.ts';
import { nativeChatTools } from '../src/native-tools.ts';
import { formats, nativeRoutes, nativeReply, selectReply, use, isCompletionRequest } from './native-fixture.mjs';

const tableId = randomUUID();
const name = { id: randomUUID(), label: 'Name', kind: 'text', required: true, maxLength: 200 };
const status = {
  id: randomUUID(),
  label: 'Status',
  kind: 'single-select',
  required: false,
  options: [{ id: randomUUID(), label: 'Done', retired: false }],
};
const due = { id: randomUUID(), label: 'Due', kind: 'date', required: false };
const definition = {
  formatVersion: 2,
  id: tableId,
  owningTeamId: randomUUID(),
  label: 'Tasks',
  fields: [name, status, due],
  uniqueKeys: [],
};
const revision = 'a'.repeat(40);
const csv = 'Name,Status,Due\nsample-golf,done,\nsample-hotel,Done,2026-11-12';

for (const { format, route, label } of [
  ...formats.map(format => ({ format, route: nativeRoutes[format], label: format })),
  {
    format: 'azure',
    label: 'xai',
    route: { provider: 'xai', endpoint: 'https://api.x.ai/', model: 'grok-4.3', apiKey: 'synthetic-key' },
  },
])
  for (const verb of ['Import', 'Add', 'Load', 'Insert'])
    for (const [encoding, pasted] of [
      ['CSV', csv],
      ['TSV', 'Name\tStatus\tDue\r\nsample, golf\tdone\t\r\nsample-hotel\tDone\t2026-11-12\r\n'],
    ])
      test(`${label}: ${verb} pasted ${encoding} recovers a file question into one whole-batch review`, async t => {
        let round = 0;
        const executed = [];
        let prepared;
        t.mock.method(globalThis, 'fetch', async (_url, init) => {
          const body = JSON.parse(init.body);
          if (isCompletionRequest(body))
            return Response.json(
              selectReply(format, { status: 'waiting', reason: 'One real batch proposal waits for approval.' }),
            );
          const tools = nativeChatTools(undefined, false, new Set()).tools;
          assert.ok(
            tools.some(tool => tool.name === 'tables_import_paste'),
            'pasted import is core, not deferred',
          );
          switch (round++) {
            case 0:
              return Response.json(
                nativeReply(format, { text: 'Please attach a CSV file so I can import these rows.' }),
              );
            case 1:
              assert.match(JSON.stringify(body), /already supplied CSV data/);
              return Response.json(nativeReply(format, { calls: [use('schema.inspect', { tableId })] }));
            case 2:
              return Response.json(
                nativeReply(format, { calls: [use('tables.import.paste', { tableId, csv: pasted })] }),
              );
            case 3:
              return Response.json(
                nativeReply(format, { calls: [use('tables.propose', { input: JSON.stringify(prepared.input) })] }),
              );
            default:
              return Response.json(
                nativeReply(format, { text: 'Review the 2 rows on the card. Nothing has been added.' }),
              );
          }
        });
        const result = await inferWithTools(
          route,
          [{ role: 'user', text: `${verb} these rows into Tasks:\n${pasted}` }],
          async call => {
            executed.push(call);
            if (call.tool === 'schema.inspect') return { appliedDefinition: definition, appliedRevision: revision };
            if (call.tool === 'tables.import.paste')
              return (prepared = await preparePastedImport(call.csv, definition, revision));
            if (call.tool === 'tables.propose') return { id: randomUUID(), digest: 'b'.repeat(64), status: 'pending' };
            assert.fail(`Unexpected call ${call.tool}`);
          },
        );
        assert.doesNotMatch(result.text, /attach.*file/i);
        assert.deepEqual(
          executed.map(call => call.tool),
          ['schema.inspect', 'tables.import.paste', 'tables.propose'],
        );
        assert.equal(prepared.input.plans[0].changes.length, 2);
      });

test('a repeated file question gets only one corrective retry and no tool or extra model calls', async t => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    requests++;
    return Response.json(nativeReply('anthropic', { text: 'Please upload a CSV file.' }));
  });
  const result = await inferWithTools(
    nativeRoutes.anthropic,
    [{ role: 'user', text: `Import these rows into Tasks:\n${csv}` }],
    () => assert.fail(),
  );
  assert.equal(requests, 2);
  assert.equal(result.text, 'Please upload a CSV file.');
});

test('a legitimate clarification and a file import without pasted rows are untouched', async t => {
  for (const [request, answer] of [
    [`Import these rows:\n${csv}`, 'Should each date use the Paris or Tokyo time zone?'],
    [`Import these rows:\n${csv}`, 'No need to attach a CSV file; the pasted data is already available.'],
    ['Import the spreadsheet into Tasks.', 'Please attach the spreadsheet file.'],
    [
      'Can you import my customer list into Leads, please?\nIt has Name, Email and Phone columns.',
      'Please attach the CSV file.',
    ],
    [
      'Import this list into Tasks:\n- Name, Status\n- sample-golf, done\n- sample-hotel, done',
      'Please attach the CSV file.',
    ],
    [
      'Import this list into Tasks:\n1. Name, Status\n2. sample-golf, done\n3. sample-hotel, done',
      'Please attach the CSV file.',
    ],
    [
      'Import this address into Contacts:\n12 Rose Lane, Apartment 3\nSpringfield, IL 62704\nUnited States, North America',
      'Please attach the CSV file.',
    ],
    ['Import these rows into Tasks:\nName,Status,Due\nsample-golf,done,', 'Please attach the CSV file.'],
    [
      'Import these rows into Tasks:\nName,Status,Due\nsample-golf,done\nsample-hotel,done,',
      'Please attach the CSV file.',
    ],
    [
      'Import these rows into Tasks:\nName,Status,Due\nsample-golf,done,\nsample-hotel,done,\nsample-india,done',
      'Please attach the CSV file.',
    ],
  ]) {
    let requests = 0;
    t.mock.method(globalThis, 'fetch', async () => {
      requests++;
      return Response.json(nativeReply('anthropic', { text: answer }));
    });
    const result = await inferWithTools(nativeRoutes.anthropic, [{ role: 'user', text: request }], () => assert.fail());
    assert.equal(result.text, answer);
    assert.equal(requests, 1);
    t.mock.restoreAll();
  }
});
