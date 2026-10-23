import assert from 'node:assert/strict';
import { test } from 'node:test';
import { invokeGoogleTool } from '../src/google-tools.ts';

const context = {
  workspaceId: '00000000-0000-4000-8000-000000000001',
  actor: { kind: 'human', userId: 'user', membershipId: '00000000-0000-4000-8000-000000000002' },
  callId: '00000000-0000-4000-8000-000000000003',
};
function propose(call) {
  const proposals = [];
  const factory = () => ({
    propose: async (_workspaceId, _userId, input) => {
      proposals.push(input);
      return { id: 'proposal', operation: input.operation };
    },
  });
  return invokeGoogleTool({}, factory, context, { tool: 'google.propose', ...call }).then(result => ({
    result,
    proposals,
  }));
}

test('a document proposal renders the spec into a converting Drive upload and keeps the bytes out of the result', async () => {
  const { result, proposals } = await propose({
    document: {
      name: 'Budget',
      format: 'xlsx',
      folderId: 'folder1',
      content: JSON.stringify({ sheets: [{ name: 'Budget', rows: [[1, { formula: '=A1*2' }]] }] }),
    },
  });
  const [operation] = proposals.map(input => input.operation);
  assert.equal(operation.kind, 'drive.files.upload');
  assert.equal(operation.mimeType, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.deepEqual(operation.file, {
    name: 'Budget',
    mimeType: 'application/vnd.google-apps.spreadsheet',
    parents: ['folder1'],
  });
  assert.equal(Buffer.from(operation.contentBase64, 'base64').subarray(0, 2).toString(), 'PK');
  assert.equal(result.data.operation.contentBase64, undefined);
  assert.equal(result.data.operation.contentBytes, Buffer.from(operation.contentBase64, 'base64').byteLength);
});

test('a document proposal with an invalid spec, or without exactly one input, creates nothing', async () => {
  const invalid = await propose({ document: { name: 'Deck', format: 'pptx', content: '{"slides":[]}' } });
  assert.equal(invalid.result.error, 'invalid-operation');
  assert.match(invalid.result.message, /document spec is invalid/);
  const image = await propose({
    document: {
      name: 'Brief',
      format: 'docx',
      content: JSON.stringify({ blocks: [{ type: 'image', fileId: '5b0f6f8e-2f0a-4c3b-9d7e-1a2b3c4d5e6f' }] }),
    },
  });
  assert.equal(image.result.error, 'invalid-operation');
  assert.match(image.result.message, /Images are not supported in Google Drive/);
  const neither = await propose({});
  assert.equal(neither.result.message, 'Set exactly one of operation or document.');
  assert.deepEqual([...invalid.proposals, ...image.proposals, ...neither.proposals], []);
});

test('existing file edits keep the original target instead of rendering a replacement', async () => {
  for (const operation of [
    {
      kind: 'docs.documents.batchUpdate',
      documentId: 'original-doc',
      requiredRevisionId: 'rev-1',
      requests: [
        {
          updateParagraphStyle: {
            range: { startIndex: 1, endIndex: 5 },
            paragraphStyle: { namedStyleType: 'HEADING_1' },
            fields: 'namedStyleType',
          },
        },
      ],
    },
    {
      kind: 'slides.presentations.batchUpdate',
      presentationId: 'original-deck',
      requiredRevisionId: 'rev-1',
      requests: [{ updateSlidesPosition: { slideObjectIds: ['slide1'], insertionIndex: 0 } }],
    },
    {
      kind: 'sheets.values.update',
      spreadsheetId: 'previously-created-sheet',
      range: 'A1',
      values: [['Updated']],
      valueInputOption: 'RAW',
    },
  ]) {
    const { proposals, result } = await propose({ operation });
    assert.deepEqual(proposals, [{ commandId: context.callId, operation }]);
    assert.deepEqual(result.data.operation, operation);
  }
});
