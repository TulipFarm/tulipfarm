import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { uuidSchema } from '../dist/documents/records.js';
import {
  citationSchema,
  sourceInput,
  createRevisionInput,
  originalSchema,
  lexicalInput,
  proofInput,
} from '../dist/documents/contracts.js';
import {
  embeddingWorkSchema,
  embeddingQuerySchema,
  embeddingRetrySchema,
  embeddingDocumentRetrySchema,
  embeddingQueryStatusSchema,
  embeddingDocumentStatusSchema,
} from '../dist/contracts/embeddings.js';
import { knowledgeCitationSchema } from '../dist/contracts/knowledge.js';

const uppercase = 'ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF';
const lowercase = uppercase.toLowerCase();
const citation = {
  kind: 'knowledge-document',
  workspaceId: uppercase,
  sourceId: uppercase,
  documentId: uppercase,
  revisionId: uppercase,
  publicationId: uppercase,
  accessEpoch: 1,
  ordinal: 0,
};

test('the internal UUID schema accepts uppercase UUIDs and normalizes them as the host did', () => {
  assert.equal(uuidSchema.parse(uppercase), lowercase);
  assert.equal(uuidSchema.parse(lowercase), lowercase);
  assert.equal(uuidSchema.safeParse('not-a-uuid').success, false);
});

test('every moved document and embedding UUID field preserves lowercase normalization', () => {
  for (const schema of [
    sourceInput,
    createRevisionInput(z.array(z.object({ kind: z.literal('knowledge-document') }))),
    lexicalInput,
    proofInput,
    embeddingWorkSchema,
    embeddingQuerySchema,
    embeddingRetrySchema,
    embeddingDocumentRetrySchema,
    embeddingQueryStatusSchema,
    embeddingDocumentStatusSchema,
  ]) {
    const fields = Object.entries(schema.shape).filter(
      ([key]) => !['profileId', 'nativeId'].includes(key) && (key === 'id' || key.endsWith('Id')),
    );
    assert.ok(fields.length > 0);
    for (const [name, field] of fields) assert.equal(field.parse(uppercase), lowercase, name);
  }
  assert.equal(
    originalSchema.parse({ kind: 'object', key: uppercase, sha256: 'a'.repeat(64), bytes: 1 }).key,
    lowercase,
  );
  assert.equal(
    originalSchema.parse({ kind: 'file', fileId: uppercase, sha256: 'a'.repeat(64), bytes: 1 }).fileId,
    lowercase,
  );
  assert.deepEqual(citationSchema.parse(citation), {
    ...citation,
    workspaceId: lowercase,
    sourceId: lowercase,
    documentId: lowercase,
    revisionId: lowercase,
    publicationId: lowercase,
  });
  assert.equal(createRevisionInput(z.array(z.never())).shape.nativeId.parse(uppercase), uppercase);
  assert.equal(embeddingQueryStatusSchema.shape.profileId.parse(uppercase), uppercase);
});

test('the earlier browser citation contract retains its original case-preserving behavior', () => {
  assert.deepEqual(knowledgeCitationSchema.parse(citation), citation);
});
