import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { z } from 'zod';
import { createDocumentStore } from '../dist/documents/store.js';
import { createRevisionInput, KnowledgeError } from '../dist/documents/contracts.js';

class Denied extends Error {}
class Unavailable extends Denied {}
const allowed = value => ({ kind: 'allowed', value });
const result = (...rows) => ({ rows, rowCount: rows.length });

function fixture({ afterChunkRead, afterChunkWrite, refreshExternalProof } = {}) {
  const tenantId = randomUUID();
  const principal = { kind: 'human', userId: 'reader', membershipId: randomUUID() };
  const sourceId = randomUUID();
  const context = Symbol('opaque transaction');
  const trace = [];
  const source = {
    id: sourceId,
    provider: 'note',
    owner_membership_id: principal.membershipId,
    account_namespace: 'notes',
    selection: 'personal',
    state: 'active',
    access_epoch: 1,
  };
  const documents = new Map();
  const revisions = new Map();
  const publications = new Map();
  const chunks = new Map();
  const work = new Map();
  let revoked = false;
  let denyProof = false;
  const denied = new Denied('revoked');
  const repository = {
    readSource: () => result(source),
    readDocument: ([id]) => (documents.has(id) ? result(documents.get(id)) : result()),
    readRevision: ([id]) => (revisions.has(id) ? result(revisions.get(id)) : result()),
    readDocumentRevision: ([id, documentId]) =>
      revisions.get(id)?.document_id === documentId ? result(revisions.get(id)) : result(),
    documentUsage: () => result({ documents: documents.size, revisions: revisions.size, bytes: 0 }),
    insertDocument: ([id, source_id, native_id]) => {
      documents.set(id, {
        id,
        source_id,
        native_id,
        observed_revision_id: null,
        lexical_publication_id: null,
        vector_publication_id: null,
        tombstoned_at: null,
      });
      return result();
    },
    insertRevision: ([id, document_id, , title, canonical_url, original, , , sources, fingerprint]) => {
      revisions.set(id, { id, document_id, title, canonical_url, original, sources: JSON.parse(sources), fingerprint });
      return result();
    },
    insertWork: ([id]) => {
      work.set(id, { parsing: 'queued', embedding: 'queued', failure: null, attempts: 0 });
      return result();
    },
    observeDocument: ([id, revisionId]) => {
      documents.get(id).observed_revision_id = revisionId;
      return result();
    },
    readParsing: ([id]) => result({ parsing: work.get(id).parsing }),
    publicationFingerprint: ([id]) => (publications.has(id) ? result(publications.get(id)) : result()),
    publicationUsage: () => result({ publications: publications.size, chunks: chunks.size, bytes: 0 }),
    insertPublication: ([id, document_id, revision_id, markdown, pages, tokens, chunk_count, fingerprint]) => {
      publications.set(id, { id, document_id, revision_id, markdown, pages, tokens, chunk_count, fingerprint });
      return result();
    },
    insertChunk: ([publicationId, ordinal, heading, passage, , source_offset]) => {
      chunks.set(`${publicationId}:${ordinal}`, { heading, passage, source_offset });
      afterChunkWrite?.(() => {
        denyProof = true;
      });
      return result();
    },
    publishDocument: ([id, publicationId]) => {
      documents.get(id).lexical_publication_id = publicationId;
      return result();
    },
    completeParsing: ([id]) => {
      work.get(id).parsing = 'ready';
      return result();
    },
    readChunk: ([id, ordinal]) => {
      const row = chunks.get(`${id}:${ordinal}`);
      afterChunkRead?.(() => {
        revoked = true;
      });
      return row ? result(row) : result();
    },
    readWork: ([id]) => result(work.get(id)),
    currentTime: () => result({ now: new Date(1000) }),
    recordProof: () => result({}),
  };
  for (const [name, operation] of Object.entries(repository))
    repository[name] = (...args) => {
      trace.push(name);
      return operation(...args);
    };
  const sourceDependenciesSchema = z.array(z.object({ kind: z.literal('knowledge-document') }));
  const store = createDocumentStore({
    runtime: {
      async transaction(id, options, operation) {
        assert.equal(id, tenantId);
        trace.push(['transaction', options]);
        const maps = [documents, revisions, publications, chunks, work];
        const snapshots = maps.map(map => structuredClone(map));
        try {
          return await operation(context);
        } catch (error) {
          maps.forEach((map, index) => {
            map.clear();
            for (const [key, value] of snapshots[index]) map.set(key, value);
          });
          throw error;
        }
      },
    },
    repository: value => {
      assert.equal(value, context);
      return repository;
    },
    authorization: {
      admit: async (value, actor, mode) => {
        assert.equal(value, context);
        assert.equal(actor, principal);
        trace.push(`admit:${mode}`);
        return allowed(principal);
      },
      bind: value => {
        assert.equal(value, context);
        trace.push('bind');
        return value;
      },
      document: async value => {
        trace.push('document');
        return value && !value.tombstoned_at ? allowed(value) : { kind: 'denied', error: denied };
      },
      knowledgeDependency: dependency => dependency,
      authority: (value, actor) => {
        assert.equal(value, context);
        assert.equal(actor, principal);
        return {
          async decide(check, input) {
            trace.push(check);
            if (revoked || (denyProof && check === 'proof')) return { kind: 'denied', error: denied };
            if (check === 'source') return input.value ? allowed(input.value) : { kind: 'denied', error: denied };
            if (check === 'dependencies') return allowed(input.sources);
            if (check === 'tenant') assert.equal(input, tenantId);
            if (check === 'binding') {
              assert.equal(input.document.observed_revision_id, input.dependency.revisionId);
              assert.equal(input.document.lexical_publication_id, input.dependency.publicationId);
              assert.equal(input.source.access_epoch, input.dependency.accessEpoch);
            }
            assert.ok(['observation', 'tenant', 'binding', 'proof'].includes(check), check);
            return allowed(undefined);
          },
        };
      },
    },
    errors: { AccessDenied: Denied, SourceAuthorizationUnavailable: Unavailable },
    tenantId: value => {
      assert.equal(value, context);
      return tenantId;
    },
    sourceDependenciesSchema,
    revisionInput: createRevisionInput(sourceDependenciesSchema),
    egressPolicy: { deny: () => trace.push('egress') },
    invalidateRecommendationSource: async () => trace.push('invalidate'),
    recordRecommendationChange: async () => trace.push('recommendation'),
    ...(refreshExternalProof ? { refreshExternalProof } : {}),
  });
  const documentId = randomUUID();
  const revisionId = randomUUID();
  const publicationId = randomUUID();
  const observation = {
    id: revisionId,
    documentId,
    sourceId,
    nativeId: 'note',
    expectedRevisionId: null,
    sourceRevision: '1',
    title: 'A note',
    canonicalUrl: null,
    original: { kind: 'object', key: revisionId, sha256: 'a'.repeat(64), bytes: 1 },
    parserProfile: { id: 'text', engine: 'text', version: '1', normalization: 'text', ocr: 'disabled' },
  };
  const publication = {
    id: publicationId,
    documentId,
    revisionId,
    markdown: 'evidence',
    pages: 0,
    tokens: 1,
    chunks: [{ heading: 'Heading', text: 'evidence', tokens: 1, offset: { kind: 'passage' } }],
  };
  async function seed() {
    await store.api.observeRevision(tenantId, principal, observation);
    return store.api.publishLexical(tenantId, principal, publication);
  }
  return {
    store,
    seed,
    tenantId,
    principal,
    documentId,
    revisionId,
    publicationId,
    observation,
    publication,
    trace,
    documents,
    publications,
    chunks,
    denied,
  };
}

test('document lifecycle runs through in-memory operations with a symbol transaction and idempotent revisions', async () => {
  const f = fixture();
  const citation = await f.seed();
  const revision = await f.store.api.observeRevision(f.tenantId, f.principal, f.observation);
  assert.equal(revision.revisionId, f.revisionId);
  assert.equal(f.publications.size, 1);
  f.trace.length = 0;
  const evidence = await f.store.api.readEvidence(f.tenantId, f.principal, citation);
  assert.equal(evidence.text, 'evidence');
  assert.deepEqual(f.trace, [
    ['transaction', {}],
    'admit:read',
    'bind',
    'tenant',
    'readDocument',
    'document',
    'readSource',
    'source',
    'binding',
    'readDocumentRevision',
    'dependencies',
    'proof',
    'readChunk',
    'tenant',
    'readDocument',
    'document',
    'readSource',
    'source',
    'binding',
    'readDocumentRevision',
    'dependencies',
    'proof',
  ]);
  await assert.rejects(
    f.store.api.observeRevision(f.tenantId, f.principal, { ...f.observation, title: 'changed replay' }),
    error => error instanceof KnowledgeError && error.code === 'conflict',
  );
});

test('evidence is not returned when access is revoked after the chunk read', async () => {
  const f = fixture({ afterChunkRead: revoke => revoke() });
  const citation = await f.seed();
  await assert.rejects(f.store.api.readEvidence(f.tenantId, f.principal, citation), error => error === f.denied);
  assert.equal(f.trace.filter(value => value === 'readChunk').length, 1);
  assert.equal(f.trace.at(-1), 'tenant');
});

test('publication rechecks proof after chunk writes and the runtime rolls back a denial', async () => {
  const f = fixture({ afterChunkWrite: deny => deny() });
  await f.store.api.observeRevision(f.tenantId, f.principal, f.observation);
  await assert.rejects(f.store.api.publishLexical(f.tenantId, f.principal, f.publication), error => error === f.denied);
  assert.equal(f.publications.size, 0);
  assert.equal(f.chunks.size, 0);
  assert.equal(f.documents.get(f.documentId).lexical_publication_id, null);
  assert.ok(!f.trace.includes('publishDocument'));
});

test('access proofs use the repository clock, preserve bare callback invocation, and reject exact expiry', async () => {
  let expiresAt = 300000;
  let receiver;
  const f = fixture({
    refreshExternalProof: async function (input) {
      receiver = this;
      return {
        id: randomUUID(),
        documentId: input.documentId,
        accessEpoch: input.accessEpoch,
        principal: 'reader',
        aclVersion: '1',
        membershipVersion: '1',
        aclCheckedAt: new Date(0),
        membershipCheckedAt: new Date(0),
        expiresAt: new Date(expiresAt),
      };
    },
  });
  await f.seed();
  const request = { documentId: f.documentId, accessEpoch: 1 };
  await f.store.api.recordAccessProof(f.tenantId, f.principal, request);
  assert.equal(receiver, undefined);
  assert.ok(f.trace.indexOf('currentTime') < f.trace.indexOf('recordProof'));
  f.trace.length = 0;
  expiresAt = 1000;
  await assert.rejects(
    f.store.api.recordAccessProof(f.tenantId, f.principal, request),
    error => error instanceof KnowledgeError && error.code === 'permission-expired',
  );
  assert.ok(!f.trace.includes('recordProof'));
});
