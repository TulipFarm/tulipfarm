import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { googleAgentOperationSchema, googleWriteTarget } from '../src/operation-contracts.ts';
import { dispatchGoogleOperation } from '../src/operation-provider.ts';
import { freshPresentation, slidesFake } from './slides-fixture.mjs';

const accessToken = 'editing-fixture-access-token';
const docRange = { startIndex: 1, endIndex: 5, tabId: 't.1' };
const textStyle = { fontSize: { magnitude: 18, unit: 'PT' }, bold: true };
const docs = {
  insertText: { location: { index: 1, tabId: 't.1', segmentId: 'h.1' }, text: 'Updated' },
  replaceAllText: { containsText: { text: 'Old', matchCase: true }, replaceText: 'New' },
  deleteContentRange: { range: docRange },
  updateTextStyle: { range: docRange, textStyle, fields: 'fontSize,bold' },
  updateParagraphStyle: {
    range: docRange,
    paragraphStyle: { namedStyleType: 'HEADING_1', alignment: 'CENTER', spaceAbove: { magnitude: 6, unit: 'PT' } },
    fields: 'namedStyleType,alignment,spaceAbove',
  },
  createParagraphBullets: { range: docRange, bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE' },
  insertTable: { rows: 2, columns: 2, location: { index: 1, tabId: 't.1' } },
};
const cellLocation = { rowIndex: 1, columnIndex: 2 };
const slides = {
  replaceAllText: { containsText: { text: 'Old', matchCase: true }, replaceText: 'New', pageObjectIds: ['slide1'] },
  insertText: { objectId: 'table1', cellLocation, insertionIndex: 0, text: 'Updated' },
  deleteText: { objectId: 'table1', cellLocation, textRange: { type: 'ALL' } },
  createSlide: { objectId: 'slide1' },
  deleteObject: { objectId: 'shape1' },
  updateSlidesPosition: { slideObjectIds: ['slide1', 'slide2'], insertionIndex: 3 },
  updatePageElementTransform: {
    objectId: 'shape1',
    applyMode: 'ABSOLUTE',
    transform: { scaleX: 1, scaleY: 1, shearX: 0, shearY: 0, translateX: 40, translateY: 60, unit: 'PT' },
  },
  updateTextStyle: {
    objectId: 'table1',
    cellLocation,
    textRange: { type: 'ALL' },
    style: textStyle,
    fields: 'fontSize,bold',
  },
};

for (const [service, requests] of [
  ['docs', docs],
  ['slides', slides],
]) {
  test(`${service} skill edit requests pass the real schema and preserve target and revision on HTTP`, async () => {
    const skill = await readFile(new URL(`../../agents/skills/google-${service}/SKILL.md`, import.meta.url), 'utf8');
    const advertised = skill.match(/Use (?:Docs|Slides) API requests such as (.+?)\./)[1];
    assert.deepEqual([...advertised.matchAll(/`(\w+)`/g)].map(match => match[1]).sort(), Object.keys(requests).sort());
    const operation = googleAgentOperationSchema.parse({
      kind: service === 'docs' ? 'docs.documents.batchUpdate' : 'slides.presentations.batchUpdate',
      [service === 'docs' ? 'documentId' : 'presentationId']: 'existing-file',
      requiredRevisionId: 'reviewed-revision',
      requests: Object.entries(requests).map(([kind, request]) => ({ [kind]: request })),
    });
    assert.equal(googleWriteTarget(operation).kind, 'revision');
    await dispatchGoogleOperation({
      operation,
      accessToken,
      fetcher: async (url, init) => {
        assert.equal(
          url.pathname,
          `/v1/${service === 'docs' ? 'documents' : 'presentations'}/existing-file:batchUpdate`,
        );
        assert.deepEqual(JSON.parse(init.body), {
          requests: operation.requests,
          writeControl: { requiredRevisionId: 'reviewed-revision' },
        });
        return Response.json({ replies: [] });
      },
    });
    assert.match(skill, /Do not replace an edit with a new file or copy unless the person agrees/);
    assert.match(skill, /operation-target-stale/);
    assert.doesNotMatch(skill, /`target-stale`/);
  });
}

test('Sheet IDs accept the full nonnegative int32 range on every structural surface without weakening position limits', () => {
  for (const sheetId of [0, 10_000_001, 123_456_789, 2_147_483_647]) {
    const range = { sheetId, startRowIndex: 0, endRowIndex: 1 };
    const dimensions = { sheetId, dimension: 'ROWS', startIndex: 0, endIndex: 1 };
    const operation = googleAgentOperationSchema.parse({
      kind: 'sheets.spreadsheets.batchUpdate',
      spreadsheetId: 'sheet-original',
      requests: [
        { addSheet: { properties: { sheetId, title: 'New' } } },
        { deleteSheet: { sheetId } },
        { updateSheetProperties: { properties: { sheetId, title: 'Updated' }, fields: 'title' } },
        {
          repeatCell: {
            range,
            cell: { userEnteredFormat: { textFormat: { bold: true } } },
            fields: 'userEnteredFormat',
          },
        },
        { insertDimension: { range: dimensions } },
        { deleteDimension: { range: dimensions } },
        { autoResizeDimensions: { dimensions } },
        { mergeCells: { range, mergeType: 'MERGE_ALL' } },
        { unmergeCells: { range } },
      ],
    });
    assert.equal(googleWriteTarget(operation).kind, 'created-spreadsheet', 'the original-file gate remains');
  }
  for (const sheetId of [-1, 1.5, 2_147_483_648])
    assert.equal(
      googleAgentOperationSchema.safeParse({
        kind: 'sheets.spreadsheets.batchUpdate',
        spreadsheetId: 's1',
        requests: [{ deleteSheet: { sheetId } }],
      }).success,
      false,
    );
  assert.equal(
    googleAgentOperationSchema.safeParse({
      kind: 'sheets.spreadsheets.batchUpdate',
      spreadsheetId: 's1',
      requests: [
        {
          deleteDimension: { range: { sheetId: 123_456_789, dimension: 'ROWS', startIndex: 0, endIndex: 10_000_001 } },
        },
      ],
    }).success,
    false,
  );
});

const paragraph = (startIndex, content) => ({
  startIndex,
  endIndex: startIndex + content.length,
  paragraph: {
    paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
    elements: [{ startIndex, endIndex: startIndex + content.length, textRun: { content, textStyle: { bold: true } } }],
  },
});
function documentFixture() {
  return {
    documentId: 'doc-original',
    title: 'Large document',
    revisionId: 'rev-1',
    tabs: [
      {
        tabProperties: { tabId: 't.1', title: 'Main' },
        documentTab: {
          body: { content: [paragraph(1, 'x'.repeat(100_000))] },
          headers: { 'h.1': { content: [paragraph(0, 'Header')] } },
        },
        childTabs: [
          {
            tabProperties: { tabId: 't.2', title: 'Nested' },
            documentTab: {
              body: {
                content: [
                  {
                    startIndex: 1,
                    endIndex: 11,
                    table: {
                      rows: 1,
                      columns: 1,
                      tableRows: [
                        {
                          startIndex: 2,
                          endIndex: 11,
                          tableCells: [{ startIndex: 3, endIndex: 11, content: [paragraph(4, 'A🌷BCD\n')] }],
                        },
                      ],
                    },
                  },
                ],
              },
            },
          },
        ],
      },
    ],
  };
}
const readDoc = (document, selection) =>
  dispatchGoogleOperation({
    operation: { kind: 'docs.documents.get', documentId: 'doc-original', selection },
    accessToken,
    fetcher: async url => {
      assert.equal(url.searchParams.get('includeTabsContent'), 'true');
      return Response.json(document);
    },
  });

test('large Docs have bounded outline and range reads with tab, segment, revision and original UTF-16 indexes', async () => {
  const document = documentFixture();
  assert.ok(JSON.stringify(document).length > 96_000);
  const outline = await readDoc(document, { view: 'outline' });
  assert.deepEqual(
    outline.tabs.map(tab => tab.tabProperties.tabId),
    ['t.1', 't.2'],
  );
  assert.deepEqual(outline.tabs[0].segments, [
    { kind: 'body', endIndex: 100_001 },
    { kind: 'headers', segmentId: 'h.1', endIndex: 6 },
  ]);
  const range = await readDoc(document, {
    view: 'range',
    tabId: 't.1',
    range: { startIndex: 90_000, endIndex: 100_000 },
  });
  assert.ok(JSON.stringify({ provider: 'google-workspace', untrusted: true, data: range }).length < 64_000);
  assert.deepEqual(
    [range.documentId, range.revisionId, range.tabId, range.segmentEndIndex],
    ['doc-original', 'rev-1', 't.1', 100_001],
  );
  assert.deepEqual(range.content[0].paragraph.elements[0], {
    startIndex: 90_000,
    endIndex: 100_000,
    textRun: { content: 'x'.repeat(10_000), textStyle: { bold: true } },
  });
  const nested = await readDoc(document, { view: 'range', tabId: 't.2', range: { startIndex: 5, endIndex: 7 } });
  assert.deepEqual(nested.content[0].table.tableRows[0].tableCells[0].content[0].paragraph.elements[0], {
    startIndex: 5,
    endIndex: 7,
    textRun: { content: '🌷', textStyle: { bold: true } },
  });
  const header = await readDoc(document, {
    view: 'range',
    tabId: 't.1',
    segmentId: 'h.1',
    range: { startIndex: 1, endIndex: 4 },
  });
  assert.equal(header.segmentId, 'h.1');
  assert.equal(header.content[0].paragraph.elements[0].textRun.content, 'ead');
  document.revisionId = 'rev-2';
  assert.equal((await readDoc(document, { view: 'outline' })).revisionId, 'rev-2');
});

test('selected Docs reads explicitly reject missing targets and malformed or oversized content', async () => {
  const selection = { view: 'range', tabId: 't.1', range: { startIndex: 1, endIndex: 2 } };
  await assert.rejects(readDoc(documentFixture(), { ...selection, tabId: 'missing' }), /provider-rejected/);
  await assert.rejects(readDoc(documentFixture(), { ...selection, segmentId: 'missing' }), /provider-rejected/);
  await assert.rejects(readDoc({ ...documentFixture(), revisionId: null }, selection), /invalid-response/);
  const document = documentFixture();
  document.tabs[0].documentTab.body.content[0].paragraph.paragraphStyle = { oversized: 'x'.repeat(64_000) };
  await assert.rejects(readDoc(document, selection), /response-too-large/);
  await assert.rejects(
    readDoc({ ...documentFixture(), title: accessToken }, selection),
    /invalid-response/,
    'projection must not hide a credential reflection',
  );
});

test('Docs range boundaries omit adjacent paragraphs without renumbering retained content', async () => {
  const document = documentFixture();
  document.tabs[0].documentTab.body.content = [
    paragraph(1, 'First\n'),
    paragraph(7, 'Middle\n'),
    paragraph(14, 'Last\n'),
  ];
  const result = await readDoc(document, { view: 'range', tabId: 't.1', range: { startIndex: 7, endIndex: 14 } });
  assert.deepEqual(result.content, [paragraph(7, 'Middle\n')]);
});

test('selected reads accept exactly 64,000 serialized characters and reject 64,001', async () => {
  const page = { objectId: 'p', revisionId: 'rev-1', padding: '' };
  page.padding = 'x'.repeat(64_000 - JSON.stringify(page).length);
  const read = () =>
    dispatchGoogleOperation({
      operation: { kind: 'slides.presentations.pages.get', presentationId: 'p1', pageObjectId: 'p', detail: {} },
      accessToken,
      fetcher: async () => Response.json(page),
    });
  assert.equal(JSON.stringify(await read()).length, 64_000);
  page.padding += 'x';
  await assert.rejects(read(), /response-too-large/);
});

test('Slides detailed reads retain styles, grouped child text and transforms, with bounded element and cell reads', async () => {
  const presentation = freshPresentation();
  const page = presentation.slides[0];
  const shape = {
    objectId: 'nested-shape',
    shape: {
      text: {
        textElements: [
          { startIndex: 0, endIndex: 100_000, textRun: { content: 'x'.repeat(100_000), style: { bold: true } } },
        ],
      },
    },
  };
  page.pageElements.push({
    objectId: 'group1',
    transform: { scaleX: 2, scaleY: 2, unit: 'PT' },
    elementGroup: { children: [shape] },
  });
  page.pageElements.push({
    objectId: 'table1',
    table: {
      rows: 1,
      columns: 2,
      tableRows: [
        {
          tableCells: [
            {
              location: {},
              text: { textElements: [{ endIndex: 4, textRun: { content: 'Cell', style: { italic: true } } }] },
            },
            { location: { columnIndex: 1 }, text: { textElements: [{ endIndex: 5, textRun: { content: 'Other' } }] } },
          ],
        },
      ],
    },
  });
  const fake = slidesFake(presentation);
  const read = detail =>
    dispatchGoogleOperation({
      operation: { kind: 'slides.presentations.pages.get', presentationId: 'qa-deck', pageObjectId: 'p', detail },
      accessToken,
      fetcher: fake.fetcher,
    });
  await assert.rejects(read({}), /response-too-large/);
  const selected = await read({ elementId: 'nested-shape', range: { startIndex: 90_000, endIndex: 100_000 } });
  assert.ok(JSON.stringify(selected).length < 64_000);
  assert.equal(selected.revisionId, 'rev-fresh-1');
  assert.deepEqual(selected.ancestors, [{ objectId: 'group1', transform: { scaleX: 2, scaleY: 2, unit: 'PT' } }]);
  assert.deepEqual(selected.element.shape.text.textElements, [
    { startIndex: 90_000, endIndex: 100_000, textRun: { content: 'x'.repeat(10_000), style: { bold: true } } },
  ]);
  const cell = await read({
    elementId: 'table1',
    cellLocation: { rowIndex: 0, columnIndex: 0 },
    range: { startIndex: 1, endIndex: 3 },
  });
  assert.deepEqual(cell.element.cell.text.textElements, [
    { startIndex: 1, endIndex: 3, textRun: { content: 'el', style: { italic: true } } },
  ]);
  await assert.rejects(read({ elementId: 'missing' }), /provider-rejected/);
  await assert.rejects(
    read({ elementId: 'table1', cellLocation: { rowIndex: 9, columnIndex: 0 } }),
    /provider-rejected/,
  );
  shape.shape.text.textElements[0] = { endIndex: 5, textRun: { content: 'Small', style: { bold: true } } };
  assert.equal(
    (await read({})).pageElements[2].elementGroup.children[0].shape.text.textElements[0].textRun.style.bold,
    true,
  );
});

test('new request variants reject unknown fields, unbounded reads and invalid masks before dispatch', async () => {
  const invalid = [
    {
      kind: 'docs.documents.get',
      documentId: 'd1',
      selection: { view: 'range', tabId: 't.1', range: { startIndex: 0, endIndex: 10_001 } },
    },
    {
      kind: 'docs.documents.get',
      documentId: 'd1',
      selection: { view: 'range', range: { startIndex: 1, endIndex: 2 } },
    },
    {
      kind: 'slides.presentations.pages.get',
      presentationId: 'p1',
      pageObjectId: 'p',
      detail: { range: { startIndex: 1, endIndex: 2 } },
    },
    {
      kind: 'slides.presentations.batchUpdate',
      presentationId: 'p1',
      requests: [{ updateSlidesPosition: { slideObjectIds: ['slide1', 'slide1'], insertionIndex: 0 } }],
    },
    {
      kind: 'docs.documents.batchUpdate',
      documentId: 'd1',
      requests: [{ updateParagraphStyle: { ...docs.updateParagraphStyle, fields: '*' } }],
    },
    {
      kind: 'docs.documents.batchUpdate',
      documentId: 'd1',
      requests: [
        { updateTextStyle: { ...docs.updateTextStyle, textStyle: { fontSize: { magnitude: -1, unit: 'PT' } } } },
      ],
    },
    {
      kind: 'slides.presentations.batchUpdate',
      presentationId: 'p1',
      requests: [{ updatePageElementTransform: { ...slides.updatePageElementTransform, arbitrary: true } }],
    },
  ];
  for (const operation of invalid)
    await assert.rejects(
      dispatchGoogleOperation({
        operation,
        accessToken,
        fetcher: async () => assert.fail('invalid input reached Google'),
      }),
      /invalid-operation/,
    );
});
