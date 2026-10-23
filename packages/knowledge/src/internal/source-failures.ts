import { z } from 'zod';
import { AccessDenied } from '../authorization/contracts.ts';
import { qualified } from '@tulipfarm/workspace-storage/runtime';
import { createKnowledgeStore, type KnowledgeOptions } from './store.ts';
import { sqlExternalAuthority } from './external-authority.ts';

export const knowledgeSourceFailureLimit = 100;
const failure = z.enum([
  'unsupported',
  'encrypted',
  'malformed',
  'resource-limited',
  'ocr-required',
  'provider',
  'credits',
  'too-large',
  'excluded',
]);
// GitHub item failures shown with their own reason; any other fetch or access failure is reported as provider.
const githubReasons = [
  'unsupported',
  'encrypted',
  'malformed',
  'resource-limited',
  'ocr-required',
  'too-large',
  'excluded',
];
// A GitHub kind the connection cannot read is a coverage marker shown as needing permission, not a failed item.
const githubDeniedMarker = 'denied';
export const knowledgeSourceFailureSchema = z.strictObject({
  id: z.string().min(1),
  // Null for a provider item that failed before it became a document.
  documentId: z.uuid().nullable(),
  title: z.string(),
  canonicalUrl: z.string().nullable(),
  // failed: not searchable. ocr-unavailable: scanned content without OCR. raw-text: searchable from its raw text
  // because the converter rejected the original.
  status: z.enum(['failed', 'ocr-unavailable', 'raw-text']),
  reason: failure,
  attempts: z.number().int().min(0),
  observedAt: z.iso.datetime().nullable(),
});
export const knowledgeSourceFailuresSchema = z.strictObject({
  sourceId: z.uuid(),
  syncedAt: z.iso.datetime().nullable(),
  items: z.array(knowledgeSourceFailureSchema).max(knowledgeSourceFailureLimit),
  truncated: z.boolean(),
});
export type KnowledgeSourceFailures = z.infer<typeof knowledgeSourceFailuresSchema>;

const rowSchema = z.object({
  id: z.string(),
  document_id: z.uuid().nullable(),
  title: z.string(),
  canonical_url: z.string().nullable(),
  status: z.enum(['failed', 'ocr-unavailable', 'raw-text']),
  reason: failure,
  attempts: z.number().int(),
  observed_at: z.date().nullable(),
});

// Documents in one source that could not be parsed, or were indexed from raw text instead, for the source owner.
// Works for every provider from the shared Knowledge tables, plus GitHub items that failed without a parsed document.
export function createKnowledgeSourceFailures({ runtime }: { runtime: KnowledgeOptions['runtime'] }) {
  const store = createKnowledgeStore({ runtime, ...sqlExternalAuthority() });
  async function list(workspaceId: string, userId: string, sourceId: string): Promise<KnowledgeSourceFailures> {
    return store.transaction(workspaceId, userId, false, async (tx, human) => {
      const table = (name: string) => qualified(tx.schema, `tf_knowledge_${name}`);
      const source = z
        .object({ owner_membership_id: z.uuid(), state: z.string(), synced_at: z.date().nullable() })
        .optional()
        .parse(
          (
            await tx.client.query(`SELECT owner_membership_id,state,synced_at FROM ${table('sources')} WHERE id=$1`, [
              sourceId,
            ])
          ).rows[0],
        );
      if (!source || source.owner_membership_id !== human.membershipId || source.state === 'removed')
        throw new AccessDenied();
      const rows = z.array(rowSchema).parse(
        (
          await tx.client.query(
            `WITH docs AS (
              SELECT d.id::text AS id,d.id AS document_id,r.title,r.canonical_url,r.created_at AS observed_at,w.attempts,
                CASE WHEN w.parsing IN ('failed','ocr-unavailable') THEN w.parsing ELSE 'raw-text' END AS status,
                CASE WHEN w.parsing IN ('failed','ocr-unavailable') THEN COALESCE(w.failure,'provider') ELSE f.profile->>'fallback' END AS reason
              FROM ${table('documents')} d
              JOIN ${table('revisions')} r ON r.id=d.observed_revision_id
              JOIN ${table('work')} w ON w.revision_id=r.id
              LEFT JOIN ${table('parse_profiles')} f ON f.publication_id=d.lexical_publication_id
              WHERE d.source_id=$1 AND d.tombstoned_at IS NULL
                AND (w.parsing IN ('failed','ocr-unavailable') OR f.profile ? 'fallback')
            ), github AS (
              SELECT 'github:'||i.native_id AS id,d.id AS document_id,COALESCE(r.title,i.native_id) AS title,r.canonical_url,
                r.created_at AS observed_at,0 AS attempts,'failed' AS status,
                CASE WHEN i.failure=ANY($3::text[]) THEN i.failure ELSE 'provider' END AS reason
              FROM ${table('github_items')} i
              LEFT JOIN ${table('documents')} d ON d.id=i.document_id AND d.tombstoned_at IS NULL
              LEFT JOIN ${table('revisions')} r ON r.id=d.observed_revision_id
              WHERE i.source_id=$1 AND i.failure IS NOT NULL AND i.failure<>$4 AND (i.document_id IS NULL OR d.id IS NOT NULL)
                AND NOT EXISTS (SELECT 1 FROM docs WHERE docs.document_id=i.document_id)
            )
            SELECT * FROM (SELECT * FROM docs UNION ALL SELECT * FROM github) failures
            ORDER BY (status<>'raw-text') DESC,observed_at DESC NULLS LAST,id
            LIMIT $2`,
            [sourceId, knowledgeSourceFailureLimit + 1, githubReasons, githubDeniedMarker],
          )
        ).rows,
      );
      return knowledgeSourceFailuresSchema.parse({
        sourceId,
        syncedAt: source.synced_at?.toISOString() ?? null,
        items: rows.slice(0, knowledgeSourceFailureLimit).map(row => ({
          id: row.id,
          documentId: row.document_id,
          title: row.title,
          canonicalUrl: row.canonical_url,
          status: row.status,
          reason: row.reason,
          attempts: row.attempts,
          observedAt: row.observed_at?.toISOString() ?? null,
        })),
        truncated: rows.length > knowledgeSourceFailureLimit,
      });
    });
  }
  return { list };
}
