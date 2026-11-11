import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFileOutput } from '../../conversations/src/file-outputs.ts';
import { inferWithTools } from '../src/inference.ts';
import { nativeChatTools } from '../src/native-tools.ts';
import {
  azureStreamReply,
  isCompletionRequest,
  knownUsage,
  nativeReply,
  nativeRoutes,
  selectReply,
  use,
} from './native-fixture.mjs';

const fileId = '11111111-1111-4111-8111-111111111111';
const secondId = '22222222-2222-4222-8222-222222222222';
const create = { name: 'Report', format: 'md', content: '# Report' };
const quota = { error: 'quota', instruction: 'No file was created. Workspace storage is full.' };
const saved = {
  file: { id: fileId, name: 'Report.md', mediaType: 'text/markdown', size: 8, parentId: null },
  derivedFrom: [],
};
const full =
  "I couldn't save the file because workspace storage is full. Free up some space, then ask me to try again.";
const options = { chatFiles: true };
const models = ['grok-4.3', 'Kimi-K2.6', 'DeepSeek-V4-Pro'];
const route = model => ({ ...nativeRoutes.azure, model });

for (const model of models)
  for (const sse of [false, true]) {
    const title = `regression: ${model} ${sse ? 'SSE' : 'JSON'}`;
    for (const request of [
      'Save it as notes.md.',
      'Write it to a file called notes.md.',
      'Save this as a file.',
      'Make me a spreadsheet of these prices: A 1, B 2.',
      'Compare these prices: A 1, B 2.\n\nExplain the difference.\n\nWhen you are done, save it as a markdown file.',
      'Export the table as a CSV file.',
      'Export it as an Excel spreadsheet.',
      'Create a Word doc with these notes.',
      'Create a report.',
      'Please make me a spreadsheet of these prices.',
      'Summarise the CSV, then save it as a markdown file.',
      'Compare the prices, then could you please export everything as a docx.',
      'CREATE A SPREADSHEET of these prices: A 1, B 2.',
      'cReAtE a FiLe with my notes.',
      'Make me an Excel sheet of these prices: A 1, B 2.',
      'Turn these notes into a PowerPoint.',
      'Put these prices in a slide deck.',
      ...[
        'Excel',
        'xlsx',
        'xls',
        'sheet',
        'workbook',
        'spreadsheet',
        'PowerPoint',
        'pptx',
        'slides',
        'slide deck',
        'deck',
        'presentation',
        'Word',
        'docx',
        'doc',
        'document',
        'PDF',
        'CSV',
        'TSV',
        'txt',
        'markdown',
        'md',
        'JSON',
        'YAML',
        'HTML',
        'image',
        'archive.zip',
        'export',
        'download',
        'attachment',
      ].map(format => `Make an output using ${format}.`),
    ])
      for (const claimsSavedFile of [false, true])
        test(`${title} structured save request ${claimsSavedFile ? 'rejects a false claim' : 'recovers a missing create'}: ${request}`, async t => {
          const claim = claimsSavedFile ? 'Your file is ready.' : 'Here is the comparison of the two prices.';
          const text = 'Report.md is saved in Files.';
          let checks = 0;
          let modelRequests = 0;
          const settlements = [];
          const previews = [];
          provider(
            t,
            sse,
            [
              nativeReply('azure', { text: claim }),
              nativeReply('azure', { calls: [use('files.create', create)] }),
              nativeReply('azure', { text }),
            ],
            false,
            body => {
              modelRequests++;
              const names = body.tools.map(tool => tool.function?.name);
              assert.ok(!names.includes('files_list'), 'Save recovery must not preload listing schemas');
              if (body.tool_choice?.function?.name === 'files_create')
                assert.ok(names.includes('files_create'), 'Forced save recovery needs the create schema');
              else if (!checks) assert.ok(!names.includes('files_create'), 'Create stays lazy until classified');
            },
            body => {
              checks++;
              assert.ok(!previews.includes(claim), 'The unchecked claim must not stream before classification');
              return {
                status: JSON.parse(body.messages.at(-1).content).candidate === claim ? 'continue' : 'completed',
                fileSaveRequested: true,
                claimsSavedFile,
              };
            },
          );
          const calls = [];
          const result = await inferWithTools(
            route(model),
            [{ role: 'user', text: request }],
            async call => {
              calls.push(call.tool);
              return saved;
            },
            async () => async usage => settlements.push(usage),
            false,
            null,
            { ...options, answerText: update => previews.push(update.text) },
          );
          assert.ok(checks > 0, 'File intent must be classified by the completion checker');
          assert.deepEqual(calls, claimsSavedFile ? [] : ['files.create']);
          assert.equal(result.text, claimsSavedFile ? "I couldn't save the file. Ask me to try again." : text);
          assert.deepEqual(
            settlements,
            Array.from({ length: modelRequests + checks }, () => knownUsage),
          );
          assert.ok(!previews.includes(claim));
        });

    for (const scenario of [
      {
        request: 'Make me an Excel sheet of these prices: A 1, B 2.',
        text: 'Done! Your Excel sheet is ready.',
      },
      { request: 'Turn these notes into a PowerPoint.', text: 'Your PowerPoint deck is ready.' },
      { request: 'Put these prices in a slide deck.', text: 'Done, the slide deck is ready for you.' },
      ...[
        'Done! Your Excel sheet is ready.',
        'Your PowerPoint deck is ready.',
        'Done, the slide deck is ready for you.',
        'Your presentation is saved.',
        'Your Word document is created.',
        'Your PDF is attached.',
        'Your image is downloadable.',
        'The attachment is ready.',
        'archive.zip is ready.',
        "All done! It's ready.",
        "All done! It's saved.",
        "All done! It's created.",
        "All done! It's attached.",
        "All done! It's downloadable.",
      ].map(text => ({ request: 'Compare these prices: A 1, B 2.', text })),
    ])
      for (const checkFails of [false, true])
        test(`${title} checks file outcome claims ${checkFails ? 'with an unavailable checker' : 'before accepting'}: ${scenario.request} ${scenario.text}`, async t => {
          let checks = 0;
          const previews = [];
          provider(
            t,
            sse,
            [nativeReply('azure', { text: scenario.text })],
            checkFails,
            body => {
              const names = body.tools.map(tool => tool.function?.name);
              assert.ok(!names.includes('files_create'));
              assert.ok(!names.includes('files_list'));
            },
            () => {
              checks++;
              assert.ok(!previews.includes(scenario.text), 'An unchecked outcome claim must not stream');
              return { status: 'continue', fileSaveRequested: false, claimsSavedFile: true };
            },
          );
          const result = await inferWithTools(
            route(model),
            [{ role: 'user', text: scenario.request }],
            () => assert.fail('A false outcome claim does not authorize file creation'),
            undefined,
            false,
            null,
            { ...options, answerText: update => previews.push(update.text) },
          );
          assert.ok(checks > 0, 'Reply-side file claims must reach the completion checker');
          assert.equal(result.text, "I couldn't save the file. Ask me to try again.");
          assert.ok(!previews.includes(scenario.text));
        });

    for (const scenario of [
      { request: 'Is this explanation ready?', text: "It's ready." },
      { request: 'Make the file names shorter.', text: "I've created file names that are shorter: Notes and Budget." },
      { request: 'Save the file id for later.', text: "I've saved the file ID to memory." },
      {
        request: 'Write a file parser in Python that converts CSV to JSON.',
        text: 'When it runs, the output file is created next to the input.',
      },
      { request: 'Write the file summary here.', text: "I've generated the file summary below." },
      {
        request: 'Create the file structure for a React app in chat.',
        text: "I've created the file structure below in chat.",
      },
      { request: 'Generate a file name for my report.', text: "I've created a file name for the report: Quarterly." },
      { request: 'Remember that my main file id is X.', text: "I've saved the file ID to memory." },
      {
        request: 'Read the document and explain its source.',
        text: 'These documents are created by the finance team each week.',
      },
      { request: 'Save me time and summarise the CSV.', text: 'The CSV has two prices.' },
      { request: 'Export this as a table in chat.', text: '| Price |\n| --- |\n| 42 |' },
      { request: 'Make a note to create the report later.', text: 'The reminder is to create the report later.' },
      {
        request: 'Can you create a doc?',
        text: 'Yes, I can create a document when you tell me what it should contain.',
      },
      { request: 'Save to memory that the report file is weekly.', text: 'The report file is weekly.' },
      { request: 'Remember this: my file names use dates.', text: 'Your file names use dates.' },
    ])
      test(`${title} structured non-save verdict preserves the answer: ${scenario.request}`, async t => {
        let checks = 0;
        const previews = [];
        provider(
          t,
          sse,
          [
            nativeReply('azure', { text: scenario.text }),
            nativeReply('azure', { calls: [use('files.create', create)] }),
            nativeReply('azure', { text: 'Report.md is saved in Files.' }),
          ],
          false,
          body => assert.notEqual(body.tool_choice?.function?.name, 'files_create'),
          () => {
            checks++;
            assert.ok(!previews.includes(scenario.text), 'File-related text must wait for classification');
            return { fileSaveRequested: false, claimsSavedFile: false };
          },
        );
        const result = await inferWithTools(
          route(model),
          [{ role: 'user', text: scenario.request }],
          () => assert.fail('A non-save verdict must not dispatch a file create'),
          undefined,
          false,
          null,
          { ...options, answerText: update => previews.push(update.text) },
        );
        assert.ok(checks > 0);
        assert.equal(result.text, scenario.text);
      });

    for (const verdict of [
      {},
      { fileSaveRequested: 'true', claimsSavedFile: 'true' },
      { fileSaveRequested: 1, claimsSavedFile: null },
    ])
      test(`${title} missing or invalid file verdicts do not authorize a save: ${JSON.stringify(verdict)}`, async t => {
        const text = "I've created file names that are shorter: Notes and Budget.";
        provider(t, sse, [nativeReply('azure', { text })], false, () => {}, verdict);
        const result = await inferWithTools(
          route(model),
          [{ role: 'user', text: 'Make the file names shorter.' }],
          () => assert.fail('Only explicit true booleans can authorize save recovery'),
          undefined,
          false,
          null,
          options,
        );
        assert.equal(result.text, text);
      });

    for (const scenario of [
      {
        request: 'Save it as notes.md.',
        text: 'Your file is ready.',
        expected: "I couldn't save the file. Ask me to try again.",
      },
      {
        request: 'Make sure the budget spreadsheet adds up.',
        text: 'The totals add up to 42.',
        expected: 'The totals add up to 42.',
      },
    ])
      test(`${title} a failed checker never authorizes a save: ${scenario.text}`, async t => {
        let checks = 0;
        const previews = [];
        provider(
          t,
          sse,
          [nativeReply('azure', { text: scenario.text })],
          true,
          () => {},
          () => {
            checks++;
            return {};
          },
        );
        const result = await inferWithTools(
          route(model),
          [{ role: 'user', text: scenario.request }],
          () => assert.fail('A failed check must never create a file'),
          undefined,
          false,
          null,
          { ...options, answerText: update => previews.push(update.text) },
        );
        assert.ok(checks > 0);
        assert.equal(result.text, scenario.expected);
        if (scenario.text !== scenario.expected) assert.ok(!previews.includes(scenario.text));
      });

    for (const request of ['Create a spreadsheet comparing the two prices.', 'Create a Word doc.'])
      test(`${title} a requested save can recover without a false success claim: ${request}`, async t => {
        const text = 'Report.md is saved in Files.';
        provider(
          t,
          sse,
          [
            nativeReply('azure', { text: 'Here is the comparison of the two prices.' }),
            nativeReply('azure', { calls: [use('files.create', create)] }),
            nativeReply('azure', { text }),
          ],
          false,
          () => {},
          body => ({
            status: JSON.parse(body.messages.at(-1).content).candidate === text ? 'completed' : 'continue',
            fileSaveRequested: true,
            claimsSavedFile: JSON.parse(body.messages.at(-1).content).candidate === text,
          }),
        );
        let saves = 0;
        const result = await inferWithTools(
          route(model),
          [{ role: 'user', text: request }],
          async call => {
            assert.equal(call.tool, 'files.create');
            saves++;
            return saved;
          },
          undefined,
          false,
          null,
          options,
        );
        assert.equal(saves, 1);
        assert.equal(result.text, text);
      });

    for (const scenario of [
      {
        request: 'Make sure the budget spreadsheet adds up.',
        text: 'Yes, the totals add up to 42.',
        read: true,
      },
      {
        request: 'Write down what the budget spreadsheet says about revenue.',
        text: 'The budget spreadsheet shows revenue of 42.',
        read: true,
      },
      {
        request: 'Create an agent to summarize new documents.',
        text: 'Which folder should the agent monitor?',
        read: false,
      },
      {
        request: 'Save this to memory: my files should be named by date.',
        text: 'What date format should I use?',
        read: false,
      },
    ])
      test(`${title} preserves a non-save direct object: ${scenario.request}`, async t => {
        provider(t, sse, [
          ...(scenario.read ? [nativeReply('azure', { calls: [use('files.read', { source: fileId })] })] : []),
          nativeReply('azure', { text: scenario.text }),
          nativeReply('azure', { calls: [use('files.create', create)] }),
          nativeReply('azure', { text: 'Report.md is saved in Files.' }),
        ]);
        const calls = [];
        const result = await inferWithTools(
          route(model),
          [{ role: 'user', text: scenario.request }],
          async call => {
            calls.push(call.tool);
            return call.tool === 'files.create' ? saved : { file: 'Revenue and total: 42' };
          },
          undefined,
          false,
          null,
          options,
        );
        assert.deepEqual(calls, scenario.read ? ['files.read'] : []);
        assert.equal(result.text, scenario.text);
      });

    test(`${title} preserves a necessary question on a real file request without forcing a save`, async t => {
      const text = 'Which columns would you like?';
      provider(
        t,
        sse,
        [nativeReply('azure', { text })],
        false,
        body => assert.notEqual(body.tool_choice?.function?.name, 'files_create'),
        { status: 'waiting', fileSaveRequested: true, claimsSavedFile: false },
      );
      const result = await inferWithTools(
        route(model),
        [{ role: 'user', text: 'Create a spreadsheet of my customers.' }],
        () => assert.fail('A necessary clarification must not dispatch a file save'),
        undefined,
        false,
        null,
        options,
      );
      assert.equal(result.text, text);
    });

    test(`${title} a successful read can answer with a summary without saving anything`, async t => {
      const text = "Here's a summary I made of the file: it contains rows created last month.";
      provider(t, sse, [
        nativeReply('azure', { calls: [use('files.read', { source: fileId })] }),
        nativeReply('azure', { text }),
      ]);
      const result = await inferWithTools(
        route(model),
        [{ role: 'user', text: `Read file-id=${fileId} and write a short summary.` }],
        async () => ({ file: 'Rows created last month.' }),
        undefined,
        false,
        null,
        options,
      );
      assert.equal(result.text, text);
    });

    test(`${title} one file read does not reduce a mixed turn to fifty total calls`, async t => {
      provider(t, sse, [
        nativeReply('azure', { calls: [use('files.read', { source: fileId })] }),
        ...Array.from({ length: 60 }, (_, index) =>
          nativeReply('azure', { calls: [use('web.fetch', { url: `https://example.com/${index}` })] }),
        ),
        nativeReply('azure', { text: 'Read the file and all sixty public pages.' }),
      ]);
      let calls = 0;
      const result = await inferWithTools(
        route(model),
        [{ role: 'user', text: 'Read the attached file, then fetch sixty public pages.' }],
        async () => {
          calls++;
          return { text: 'Source text' };
        },
        undefined,
        false,
        null,
        options,
      );
      assert.equal(calls, 61);
      assert.equal(result.text, 'Read the file and all sixty public pages.');
    });

    test(`${title} creating a spreadsheet can fetch the prices it needs`, async t => {
      const calls = [];
      provider(
        t,
        sse,
        [
          nativeReply('azure', { calls: [use('web.fetch', { url: 'https://example.com/pricing' })] }),
          nativeReply('azure', {
            calls: [
              use('files.create', {
                name: 'Prices',
                format: 'xlsx',
                content: JSON.stringify({ sheets: [{ name: 'Prices', rows: [['Enterprise', 42]] }] }),
              }),
            ],
          }),
          nativeReply('azure', { text: 'Prices.xlsx is saved in Files.' }),
        ],
        false,
        body => {
          if (!calls.length) assert.ok(body.tools.some(tool => tool.function?.name === 'web_fetch'));
        },
      );
      const result = await inferWithTools(
        route(model),
        [{ role: 'user', text: 'Create a spreadsheet of the current prices on https://example.com/pricing' }],
        async call => {
          calls.push(call.tool);
          return call.tool === 'files.create'
            ? {
                ...saved,
                file: {
                  ...saved.file,
                  name: 'Prices.xlsx',
                  mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                },
              }
            : { text: 'Enterprise: 42' };
        },
        undefined,
        false,
        null,
        options,
      );
      assert.deepEqual(calls, ['web.fetch', 'files.create']);
      assert.equal(result.text, 'Prices.xlsx is saved in Files.');
    });

    test(`${title} an oversized file lets the model explain the reason without listing the library`, async t => {
      const text = 'The file is too large to read. Send a smaller file.';
      provider(t, sse, [
        nativeReply('azure', { calls: [use('files.read', { source: fileId })] }),
        nativeReply('azure', { text }),
      ]);
      const result = await inferWithTools(
        route(model),
        [{ role: 'user', text: 'Read this file.' }],
        async call => {
          assert.equal(call.tool, 'files.read', 'A size error must not trigger a library listing');
          return { error: 'too-large', instruction: 'The file is too large to read.' };
        },
        undefined,
        false,
        null,
        options,
      );
      assert.equal(result.text, text);
    });

    test(`${title} finding a file and answering a question continues beyond the listing`, async t => {
      const text = 'The enterprise tier costs 42.';
      provider(t, sse, [
        nativeReply('azure', { calls: [use('files.list', { query: 'pricing' })] }),
        nativeReply('azure', { calls: [use('files.read', { source: fileId })] }),
        nativeReply('azure', { text }),
      ]);
      const calls = [];
      const result = await inferWithTools(
        route(model),
        [{ role: 'user', text: 'Find the pricing file and tell me what the enterprise tier costs.' }],
        async call => {
          calls.push(call.tool);
          return call.tool === 'files.list'
            ? {
                items: [
                  { id: fileId, kind: 'file', name: 'Pricing.md' },
                  { id: secondId, kind: 'file', name: 'Other.md' },
                ],
                next: null,
              }
            : { file: 'Enterprise tier: 42' };
        },
        undefined,
        false,
        null,
        options,
      );
      assert.deepEqual(calls, ['files.list', 'files.read']);
      assert.equal(result.text, text);
    });

    test(`${title} describing existing spreadsheets never creates an unrequested file`, async t => {
      const text = 'These spreadsheets are generated weekly by the finance team.';
      provider(t, sse, [
        nativeReply('azure', { calls: [use('files.read', { source: fileId })] }),
        nativeReply('azure', { text }),
        nativeReply('azure', { calls: [use('files.create', create)] }),
        nativeReply('azure', { text: 'Report.md is saved in Files.' }),
      ]);
      const calls = [];
      const result = await inferWithTools(
        route(model),
        [{ role: 'user', text: `Read file-id=${fileId} and tell me what it is.` }],
        async call => {
          calls.push(call.tool);
          return call.tool === 'files.create' ? saved : { file: text };
        },
        undefined,
        false,
        null,
        options,
      );
      assert.deepEqual(calls, ['files.read']);
      assert.equal(result.text, text);
    });

    test(`${title} a requested markdown report needs a receipt even for a vague ready claim`, async t => {
      provider(t, sse, [nativeReply('azure', { text: 'Your report is ready.' })], false, () => {}, {
        status: 'continue',
        fileSaveRequested: true,
        claimsSavedFile: true,
      });
      const result = await inferWithTools(
        route(model),
        [{ role: 'user', text: 'Create a markdown report.' }],
        () => assert.fail('The model never requested a save'),
        undefined,
        false,
        null,
        options,
      );
      assert.equal(result.text, "I couldn't save the file. Ask me to try again.");
    });

    test(`${title} research followed by a requested spreadsheet holds an unbacked claim out of streamed text`, async t => {
      const claim = "I've created a spreadsheet comparing the three CRMs.";
      provider(
        t,
        sse,
        [
          nativeReply('azure', { calls: [use('web.search', { query: 'top three CRMs' })] }),
          nativeReply('azure', { text: claim }),
        ],
        false,
        () => {},
        { status: 'continue', fileSaveRequested: true, claimsSavedFile: true },
      );
      const previews = [];
      const result = await inferWithTools(
        route(model),
        [{ role: 'user', text: 'Research the top 3 CRMs and create a spreadsheet comparing them.' }],
        async call => {
          assert.equal(call.tool, 'web.search');
          return { results: [{ title: 'Three CRMs', text: 'A, B and C' }] };
        },
        undefined,
        false,
        null,
        { ...options, answerText: update => previews.push(update.text) },
      );
      assert.equal(result.text, "I couldn't save the file. Ask me to try again.");
      assert.ok(!previews.some(text => text.includes(claim)), 'An unbacked claim must not stream');
    });

    test(`${title} showing numbers inside a file continues beyond discovery`, async t => {
      const text = 'Revenue in Budget.xlsx is 42.';
      provider(t, sse, [
        nativeReply('azure', { calls: [use('files.list', { query: 'budget' })] }),
        nativeReply('azure', { calls: [use('files.read', { source: fileId })] }),
        nativeReply('azure', { text }),
      ]);
      const calls = [];
      const result = await inferWithTools(
        route(model),
        [{ role: 'user', text: 'Show me the revenue numbers in the budget file.' }],
        async call => {
          calls.push(call.tool);
          return call.tool === 'files.list'
            ? {
                items: [
                  { id: fileId, kind: 'file', name: 'Budget.xlsx' },
                  { id: secondId, kind: 'file', name: 'Other.md' },
                ],
                next: null,
              }
            : { file: 'Revenue: 42' };
        },
        undefined,
        false,
        null,
        options,
      );
      assert.deepEqual(calls, ['files.list', 'files.read']);
      assert.equal(result.text, text);
    });

    for (const claim of ["I've saved a new file in Files.", "I've saved the report to your Files."])
      test(`${title} an unsolicited save claim gets the exact failure reply without further model calls: ${claim}`, async t => {
        const text = 'The budget file contains revenue of 42.';
        let modelCalls = 0;
        provider(
          t,
          sse,
          [
            nativeReply('azure', { calls: [use('files.read', { source: fileId })] }),
            nativeReply('azure', { text: claim }),
            nativeReply('azure', { calls: [use('files.create', create)] }),
            nativeReply('azure', { text }),
          ],
          false,
          body => {
            modelCalls++;
            assert.notEqual(body.tool_choice?.function?.name, 'files_create');
          },
          body => ({
            fileSaveRequested: false,
            claimsSavedFile: JSON.parse(body.messages.at(-1).content).candidate === claim,
          }),
        );
        const previews = [];
        const result = await inferWithTools(
          route(model),
          [{ role: 'user', text: `Read file-id=${fileId} and tell me the revenue.` }],
          async call => {
            assert.equal(call.tool, 'files.read');
            return { file: 'Revenue: 42' };
          },
          undefined,
          false,
          null,
          { ...options, answerText: update => previews.push(update.text) },
        );
        assert.equal(result.text, "I couldn't save the file. Ask me to try again.");
        assert.equal(modelCalls, 2);
        assert.ok(!previews.some(text => text.includes(claim)));
      });
  }

test('an unsolicited repeated save claim returns the save-failed reply without correction', async t => {
  const claim = "I've saved a new file in Files.";
  provider(
    t,
    true,
    [nativeReply('azure', { calls: [use('files.read', { source: fileId })] }), nativeReply('azure', { text: claim })],
    false,
    () => {},
    { status: 'continue', fileSaveRequested: false, claimsSavedFile: true },
  );
  let calls = 0;
  const result = await inferWithTools(
    route(models[0]),
    [{ role: 'user', text: `Read file-id=${fileId} and tell me the revenue.` }],
    async call => {
      calls++;
      assert.equal(call.tool, 'files.read');
      return { file: 'Revenue: 42' };
    },
    undefined,
    false,
    null,
    options,
  );
  assert.equal(calls, 1);
  assert.equal(result.text, "I couldn't save the file. Ask me to try again.");
});

function provider(t, sse, replies, checkFails = false, inspect = () => {}, verdict = {}) {
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(init.body);
    if (isCompletionRequest(body)) {
      const checked = typeof verdict === 'function' ? verdict(body) : verdict;
      return checkFails
        ? Response.json({ error: { code: 'BadRequest' } }, { status: 400 })
        : Response.json(
            selectReply('azure', {
              status: 'completed',
              reason: 'The fixture answer satisfies the request.',
              fileSaveRequested: false,
              claimsSavedFile: false,
              ...checked,
            }),
          );
    }
    inspect(body);
    const reply = replies.length > 1 ? replies.shift() : replies[0];
    assert.ok(reply, 'fixture exhausted');
    if (!sse || !reply.choices[0].message.content) return sse ? azureStreamReply(reply) : Response.json(reply);
    const text = reply.choices[0].message.content;
    const events = [
      ...text.split(/(?<=\s)/).map(content => ({
        choices: [{ index: 0, delta: { content }, finish_reason: null }],
      })),
      { choices: [{ index: 0, delta: {}, finish_reason: reply.choices[0].finish_reason }], usage: reply.usage },
    ].map(event => `data: ${JSON.stringify(event)}\n\n`);
    events.push('data: [DONE]\n\n');
    return new Response(
      new ReadableStream({
        pull(controller) {
          controller.enqueue(new TextEncoder().encode(events.shift() ?? 'data: [DONE]\n\n'));
          if (!events.length) controller.close();
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    );
  });
}

test('listing and saving stay discoverable without loading their schemas on every turn', () => {
  const loaded = new Set();
  const catalog = nativeChatTools(undefined, false, loaded, true);
  const names = catalog.tools.map(tool => tool.name);
  assert.ok(names.includes('files_read'));
  for (const name of ['files_list', 'files_create']) {
    assert.ok(!names.includes(name));
    assert.ok(catalog.discovery.includes(name));
  }
  assert.deepEqual(catalog.load(['files_create']), ['files_create']);
  const recovered = nativeChatTools(undefined, false, loaded, true).tools.map(tool => tool.name);
  assert.ok(recovered.includes('files_create'));
  assert.ok(!recovered.includes('files_list'));
});

test('a search phrase is data, even when it contains action words', async t => {
  provider(t, true, [nativeReply('azure', { text: 'No matching files.' })]);
  const result = await inferWithTools(
    nativeRoutes.azure,
    [{ role: 'user', text: 'List files whose name contains "read table"' }],
    async call => {
      assert.equal(call.tool, 'files.list');
      assert.equal(call.query, 'read table');
      return { items: [{ id: fileId, kind: 'file', name: 'read table.md' }], next: null };
    },
    undefined,
    false,
    null,
    options,
  );
  assert.equal(result.text, 'read table.md');
});

test('a listed filename containing save wording remains data, not a save claim', async t => {
  const name = 'ready in Files.md';
  provider(t, true, [nativeReply('azure', { text: 'No matching files.' })]);
  const result = await inferWithTools(
    nativeRoutes.azure,
    [{ role: 'user', text: 'List my files.' }],
    async call => {
      assert.equal(call.tool, 'files.list');
      return { items: [{ id: fileId, kind: 'file', name }], next: null };
    },
    undefined,
    false,
    null,
    options,
  );
  assert.equal(result.text, name);
});

for (const request of [
  'Make a comparison table and read the budget file.',
  'Write a short summary of the budget file.',
])
  test(`text work referencing an existing file does not request a save: ${request}`, async t => {
    const text = 'Budget revenue is 42.';
    provider(t, true, [
      nativeReply('azure', { calls: [use('files.read', { source: fileId })] }),
      nativeReply('azure', { text }),
    ]);
    const result = await inferWithTools(
      nativeRoutes.azure,
      [{ role: 'user', text: request }],
      async call => {
        assert.equal(call.tool, 'files.read');
        return { file: 'Revenue: 42' };
      },
      undefined,
      false,
      null,
      options,
    );
    assert.equal(result.text, text);
  });

for (const model of models)
  for (const sse of [false, true]) {
    const title = `${model} ${sse ? 'SSE' : 'JSON'}`;
    test(`${title} lists my files with listing schemas still deferred`, async t => {
      provider(t, sse, [nativeReply('azure', { text: 'No files exist.' })], false, body => {
        assert.ok(!body.tools.some(tool => tool.function?.name === 'files_list'));
        assert.ok(body.messages.some(message => String(message.content).includes('files_list')));
      });
      const calls = [];
      const result = await inferWithTools(
        route(model),
        [{ role: 'user', text: 'List my files.' }],
        async call => {
          calls.push(call);
          return { items: [{ id: fileId, kind: 'file', name: 'Notes.md' }], next: null };
        },
        undefined,
        false,
        null,
        options,
      );
      assert.deepEqual(calls, [{ tool: 'files.list', query: '' }]);
      assert.equal(result.text, 'Notes.md');
    });

    test(`${title} lists every matching name across pages without attempting the model's unrelated read`, async t => {
      provider(t, sse, [
        nativeReply('azure', { calls: [use('files.read', { source: 'invented-id' })] }),
        nativeReply('azure', { text: 'No files exist.' }),
      ]);
      const calls = [];
      const result = await inferWithTools(
        route(model),
        [{ role: 'user', text: 'List the files in my Files whose name contains X' }],
        async call => {
          calls.push(call);
          assert.equal(call.tool, 'files.list');
          assert.equal(call.query, 'X');
          return call.after
            ? { items: [{ id: secondId, kind: 'file', name: 'X budget.xlsx' }], next: null }
            : { items: [{ id: fileId, kind: 'file', name: 'X notes.md' }], next: fileId };
        },
        undefined,
        false,
        null,
        options,
      );
      assert.equal(calls.length, 2);
      assert.match(result.text, /X notes\.md/);
      assert.match(result.text, /X budget\.xlsx/);
      assert.doesNotMatch(result.text, /No files/);
    });

    test(`${title} creating a new file keeps file reads and API tools available`, async t => {
      provider(t, sse, [
        nativeReply('azure', { calls: [use('files.read', { source: fileId })] }),
        nativeReply('azure', { calls: [use('api.request', { method: 'GET', url: 'https://example.com' })] }),
        nativeReply('azure', { calls: [use('files.create', create)] }),
        nativeReply('azure', { text: 'Report.md is saved in Files.' }),
      ]);
      const calls = [];
      const result = await inferWithTools(
        route(model),
        [{ role: 'user', text: 'Create a markdown file based on my source and public pricing data.' }],
        async call => {
          calls.push(call.tool);
          return call.tool === 'files.create' ? saved : { text: 'Source data' };
        },
        undefined,
        false,
        null,
        options,
      );
      assert.deepEqual(calls, ['files.read', 'api.request', 'files.create']);
      assert.equal(result.text, 'Report.md is saved in Files.');
    });

    for (const claim of ['Your Excel workbook is ready in Files.', 'I created Report.xlsx.'])
      test(`${title} refuses ${JSON.stringify(claim)} after failed saves, including resumed turns`, async t => {
        provider(t, sse, [
          nativeReply('azure', { calls: [use('files.create', create)] }),
          nativeReply('azure', { text: claim }),
        ]);
        const previews = [];
        const result = await inferWithTools(
          route(model),
          [{ role: 'user', text: 'Create a markdown report in Files.' }],
          async () => quota,
          undefined,
          false,
          null,
          { ...options, priorCalls: 1, answerText: update => previews.push(update.text) },
        );
        assert.equal(result.text, full);
        assert.ok(!previews.some(text => text.includes(claim)), 'an unchecked success never streams');
      });

    test(`${title} does not trust a failing completion check after a failed save`, async t => {
      provider(
        t,
        sse,
        [
          nativeReply('azure', { calls: [use('files.create', create)] }),
          nativeReply('azure', { text: 'The workbook is ready in Files.' }),
        ],
        true,
      );
      const result = await inferWithTools(
        route(model),
        [{ role: 'user', text: 'Create a report.' }],
        async () => quota,
        undefined,
        false,
        null,
        options,
      );
      assert.equal(result.text, full);
    });

    for (const format of ['md', 'xlsx'])
      test(`${title} saves ${format} once and leaves a successfully saved reply unchanged`, async t => {
        const text = `Report.${format} is saved in Files.`;
        provider(t, sse, [
          nativeReply('azure', {
            calls: [
              use('files.create', {
                ...create,
                format,
                content:
                  format === 'md'
                    ? '# Report'
                    : JSON.stringify({ sheets: [{ name: 'Report', rows: [['Total', 42]] }] }),
              }),
            ],
          }),
          nativeReply('azure', { text }),
        ]);
        const persisted = [];
        const result = await inferWithTools(
          route(model),
          [{ role: 'user', text: `Create a ${format} report.` }],
          async call => {
            assert.equal(call.tool, 'files.create');
            const output = await createFileOutput(
              {
                createDerived: async (_workspace, _user, id, metadata, bytes) => {
                  const file = { id, ...metadata, size: bytes.byteLength };
                  persisted.push(file);
                  return file;
                },
              },
              {
                workspaceId: fileId,
                actor: { kind: 'human', userId: fileId, membershipId: fileId },
                autonomous: false,
                origin: { turnId: secondId },
              },
              call,
            );
            assert.ok(output.file, JSON.stringify(output));
            assert.equal(output.file.id, persisted[0].id);
            return output;
          },
          undefined,
          false,
          null,
          options,
        );
        assert.equal(result.text, text);
        assert.equal(persisted.length, 1);
        assert.equal(persisted[0].name, `Report.${format}`);
      });

    test(`${title} preserves non-file work`, async t => {
      const text = 'The public page describes apples.';
      provider(t, sse, [
        nativeReply('azure', { calls: [use('web.fetch', { url: 'https://example.com' })] }),
        nativeReply('azure', { text }),
      ]);
      const result = await inferWithTools(
        route(model),
        [{ role: 'user', text: 'Read this public page.' }],
        async () => ({ text: 'Apples' }),
        undefined,
        false,
        null,
        options,
      );
      assert.equal(result.text, text);
    });

    test(`${title} rejects a false saved claim from the fallback route`, async t => {
      let round = 0;
      t.mock.method(globalThis, 'fetch', async (url, init) => {
        if (String(url).includes('anthropic'))
          return Response.json({ error: { type: 'api_error', message: 'Fixture unavailable' } }, { status: 500 });
        if (isCompletionRequest(JSON.parse(init.body)))
          return Response.json(
            selectReply('azure', {
              status: 'continue',
              reason: 'No file save succeeded.',
              fileSaveRequested: true,
              claimsSavedFile: true,
            }),
          );
        const reply = nativeReply(
          'azure',
          ++round === 1 ? { calls: [use('files.create', create)] } : { text: 'Your workbook is ready in Files.' },
        );
        return sse ? azureStreamReply(reply) : Response.json(reply);
      });
      const result = await inferWithTools(
        nativeRoutes.anthropic,
        [{ role: 'user', text: 'Create a markdown file.' }],
        async () => quota,
        undefined,
        false,
        null,
        { ...options, fallback: { route: route(model), label: model } },
      );
      assert.equal(result.fallback, model);
      assert.equal(result.text, full);
    });
  }

test('a resumed successful save keeps its reply without repeating the save', async t => {
  const text = 'Report.md is saved in Files.';
  provider(t, true, [nativeReply('azure', { text })]);
  const result = await inferWithTools(
    nativeRoutes.azure,
    [{ role: 'user', text: 'Create a markdown file.' }],
    () => assert.fail('Do not repeat a saved file'),
    undefined,
    false,
    null,
    {
      ...options,
      priorCalls: 1,
      priorToolCalls: [{ tool: 'files.create', ...create }],
      priorFileResults: [{ call: { tool: 'files.create', ...create }, result: saved }],
    },
  );
  assert.equal(result.text, text);
});

for (const source of [undefined, 'unknown', fileId])
  test(`a failed read of ${source ?? 'no ID'} recovers with a listing, not an empty-library claim`, async t => {
    const text = 'Report.md is available. Which file should I read?';
    provider(t, true, [
      nativeReply('azure', { calls: [use('files.read', source ? { source } : {})] }),
      nativeReply('azure', { text }),
    ]);
    const calls = [];
    const result = await inferWithTools(
      nativeRoutes.azure,
      [{ role: 'user', text: 'Read my file.' }],
      async call => {
        calls.push(call);
        return call.tool === 'files.read'
          ? { error: source ? 'file-not-found' : 'file-source-required' }
          : { items: [{ id: fileId, kind: 'file', name: 'Report.md' }], next: null };
      },
      undefined,
      false,
      null,
      options,
    );
    assert.deepEqual(
      calls.map(call => call.tool),
      ['files.read', 'files.list'],
    );
    assert.equal(result.text, text);
  });

for (const failure of [
  { error: 'invalid-content', instruction: 'No file was created. bad sheet name' },
  { error: 'provider-error', instruction: 'Private provider details' },
])
  test(`a ${failure.error} save failure gives only a safe reason`, async t => {
    provider(t, false, [
      nativeReply('azure', { calls: [use('files.create', create)] }),
      nativeReply('azure', { text: 'Your file is ready.' }),
    ]);
    const result = await inferWithTools(
      nativeRoutes.azure,
      [{ role: 'user', text: 'Create a file.' }],
      async () => failure,
      undefined,
      false,
      null,
      options,
    );
    assert.equal(
      result.text,
      failure.error === 'invalid-content'
        ? "I couldn't save the file because part of it isn't valid. Bad sheet name. Ask me to fix it and try again."
        : "I couldn't save the file. Ask me to try again.",
    );
  });

test('a different successful write cannot back a failed file save', async t => {
  provider(t, false, [
    nativeReply('azure', { calls: [use('files.rename', { fileId, name: 'Renamed' })] }),
    nativeReply('azure', { calls: [use('files.create', create)] }),
    nativeReply('azure', { text: 'Report.xlsx is ready in Files.' }),
  ]);
  const result = await inferWithTools(
    nativeRoutes.azure,
    [{ role: 'user', text: 'Rename a file and create a report.' }],
    async call => (call.tool === 'files.create' ? quota : { status: 'pending', id: secondId }),
    undefined,
    false,
    null,
    { ...options, preloadedTools: ['files.rename'] },
  );
  assert.equal(result.text, full);
});

test('a successful save is not replaced when a later save fails', async t => {
  const text = 'Report.md is saved. The second file could not be saved.';
  provider(t, false, [
    nativeReply('azure', { calls: [use('files.create', create)] }),
    nativeReply('azure', { calls: [use('files.create', { ...create, name: 'Second' })] }),
    nativeReply('azure', { text }),
  ]);
  let calls = 0;
  const result = await inferWithTools(
    nativeRoutes.azure,
    [{ role: 'user', text: 'Create two reports.' }],
    async () => (++calls === 1 ? saved : quota),
    undefined,
    false,
    null,
    options,
  );
  assert.equal(result.text, text);
});

test('a later read failure does not replace a successful file reply with a listing', async t => {
  const text = 'Report.md is saved. The source file was not available.';
  provider(t, true, [
    nativeReply('azure', { calls: [use('files.create', create)] }),
    nativeReply('azure', { calls: [use('files.read', { source: secondId })] }),
    nativeReply('azure', { text }),
  ]);
  const calls = [];
  const result = await inferWithTools(
    nativeRoutes.azure,
    [{ role: 'user', text: 'Create a report and read my source.' }],
    async call => {
      calls.push(call.tool);
      return call.tool === 'files.create' ? saved : { error: 'file-not-found' };
    },
    undefined,
    false,
    null,
    options,
  );
  assert.deepEqual(calls, ['files.create', 'files.read']);
  assert.equal(result.text, text);
});

test('file work counts only file calls toward its 50-call allowance, including resumed turns', async t => {
  let calls = 0;
  provider(t, false, [
    nativeReply('azure', { calls: [use('files.read', { source: fileId })] }),
    nativeReply('azure', { calls: [use('files.read', { source: secondId })] }),
    nativeReply('azure', { text: 'Read the files.' }),
  ]);
  await inferWithTools(
    nativeRoutes.azure,
    [{ role: 'user', text: 'Read the attached file.' }],
    async () => {
      calls++;
      return { file: 'contents' };
    },
    undefined,
    false,
    null,
    {
      ...options,
      priorCalls: 100,
      priorFileResults: Array.from({ length: 49 }, () => ({
        call: { tool: 'files.read', source: fileId },
        result: { file: 'contents' },
      })),
    },
  );
  assert.equal(calls, 1);
});

test('mentioning file fields does not cap or rewrite non-file work', async t => {
  const text = 'The public guide describes file fields.';
  provider(t, true, [
    nativeReply('azure', { calls: [use('web.fetch', { url: 'https://example.com/one' })] }),
    nativeReply('azure', { calls: [use('web.fetch', { url: 'https://example.com/two' })] }),
    nativeReply('azure', { text }),
  ]);
  let calls = 0;
  const result = await inferWithTools(
    nativeRoutes.azure,
    [{ role: 'user', text: 'Read this public guide to file fields.' }],
    async () => {
      calls++;
      return { text: 'Guide' };
    },
    undefined,
    false,
    null,
    { ...options, priorCalls: 49 },
  );
  assert.equal(calls, 2);
  assert.equal(result.text, text);
});

test('three identical failed file operations stop instead of looping', async t => {
  provider(t, false, [nativeReply('azure', { calls: [use('files.list', { query: 'report' })] })]);
  let calls = 0;
  const result = await inferWithTools(
    nativeRoutes.azure,
    [{ role: 'user', text: 'Organize my files.' }],
    async () => {
      calls++;
      return { error: 'file-not-found' };
    },
    undefined,
    false,
    null,
    options,
  );
  assert.equal(calls, 3);
  assert.equal(result.text, 'I stopped because the same file request kept failing. Ask me to try again.');
});
