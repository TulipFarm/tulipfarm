import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import {
  AccessDenied,
  SourceAuthorizationUnavailable,
  currentMember,
  lockAuthorization,
  resolveHuman,
  uuidSchema,
  type HumanActor,
} from '@tulipfarm/access';
import { requireReadableFile } from '@tulipfarm/files';
import { defaultCallTimeoutMs, knowledgeEmbeddingProfile } from '@tulipfarm/config';
import { qualified, StorageUnavailableError, commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import {
  knowledgeCitationSchema,
  knowledgeSearchFiltersSchema,
  knowledgeSearchRequestSchema,
  knowledgeSearchReasonSchema,
  type KnowledgeSearchFilters,
  type KnowledgeSearchResult,
} from '../contracts.ts';
import type { createKnowledgeEmbeddings } from './embeddings.ts';
import { KnowledgeError } from './contracts.ts';
import { createKnowledgeStore, type KnowledgeOptions } from './store.ts';
import { normalizeIdentifier } from './identifiers.ts';
import { searchEligibility } from './search-eligibility.ts';
import type { GoogleKnowledge } from './google.ts';
import type { SlackKnowledge } from './slack.ts';
import type { GitHubKnowledge } from './github.ts';
import { type AtlassianKnowledge } from './atlassian.ts';
import { externalAuthority } from './external-authority.ts';

const candidateSchema = z.object({
  document_id: uuidSchema,
  source_id: uuidSchema,
  revision_id: uuidSchema,
  publication_id: uuidSchema,
  access_epoch: z.number().int(),
  ordinal: z.number().int(),
  vector_publication_id: uuidSchema.nullable(),
  exact: z.boolean().default(false),
  broadened: z.boolean().optional(),
});
type Candidate = z.infer<typeof candidateSchema>;
const eligibleVectorSchema = z.object({
  document_id: uuidSchema,
  source_id: uuidSchema,
  revision_id: uuidSchema,
  publication_id: uuidSchema,
  access_epoch: z.number().int(),
  vector_publication_id: uuidSchema,
});
const eligibleLexicalSchema = z.object({
  document_id: uuidSchema,
  source_id: uuidSchema,
  revision_id: uuidSchema,
  publication_id: uuidSchema,
  access_epoch: z.number().int(),
  semantic: z.boolean(),
});
const lexicalMatchSchema = z.object({
  publication_id: uuidSchema,
  ordinal: z.number().int(),
  exact: z.boolean(),
  rank: z.number(),
});
const nearestSchema = z.object({
  vector_publication_id: uuidSchema,
  lexical_publication_id: uuidSchema,
  ordinal: z.number().int(),
  distance: z.number(),
});
const sessionSchema = z.object({
  id: uuidSchema,
  fingerprint: z.string(),
  filters: knowledgeSearchFiltersSchema,
  candidates: z.array(candidateSchema).max(100),
  mode: z.enum(['keyword-only', 'hybrid']),
  reason: knowledgeSearchReasonSchema.nullable(),
  coverage: z.enum(['complete', 'partial', 'keyword-only']),
  expires_at: z.date(),
});
type Session = z.infer<typeof sessionSchema>;
type Transaction = Parameters<ReturnType<typeof createKnowledgeStore>['bind']>[0];
const table = (tx: Transaction, name: string) => qualified(tx.schema, `tf_knowledge_${name}`);
const values = (actor: HumanActor, filters: KnowledgeSearchFilters) => [
  actor.membershipId,
  actor.userId,
  filters.kinds,
  filters.sourceIds,
  filters.documentIds,
];
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function fuseKnowledgeCandidates(lexical: Candidate[], semantic: Candidate[]) {
  const ranked = new Map<string, { candidate: Candidate; score: number }>();
  for (const list of [lexical, semantic])
    list.forEach((candidate, index) => {
      const key = `${candidate.publication_id}:${candidate.ordinal}`;
      const existing = ranked.get(key);
      ranked.set(key, {
        candidate: {
          ...candidate,
          exact: candidate.exact || existing?.candidate.exact === true,
          vector_publication_id: candidate.vector_publication_id ?? existing?.candidate.vector_publication_id ?? null,
          ...(candidate.broadened || existing?.candidate.broadened ? { broadened: true } : {}),
        },
        score: (existing?.score ?? 0) + 1 / (60 + index + 1),
      });
    });
  const documents = new Set<string>();
  return [...ranked.values()]
    .sort(
      (a, b) =>
        Number(b.candidate.exact) - Number(a.candidate.exact) ||
        b.score - a.score ||
        a.candidate.document_id.localeCompare(b.candidate.document_id) ||
        a.candidate.ordinal - b.candidate.ordinal,
    )
    .filter(({ candidate }) => {
      if (documents.has(candidate.document_id)) return false;
      documents.add(candidate.document_id);
      return true;
    })
    .slice(0, 100)
    .map(({ candidate }) => candidate);
}

async function until<T>(promise: Promise<T>, deadlineAt: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new StorageUnavailableError('wait_timeout')),
          Math.max(0, deadlineAt - Date.now()),
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function createKnowledgeSearch({
  runtime,
  embeddings,
  google,
  slack,
  github,
  atlassian,
}: {
  runtime: KnowledgeOptions['runtime'];
  embeddings: ReturnType<typeof createKnowledgeEmbeddings>;
  google?: GoogleKnowledge;
  slack?: SlackKnowledge;
  github?: GitHubKnowledge;
  atlassian?: AtlassianKnowledge;
}) {
  const store = createKnowledgeStore({
    runtime,
    ...externalAuthority({
      ...(google ? { google } : {}),
      ...(slack ? { slack } : {}),
      ...(github ? { github } : {}),
      ...(atlassian ? { confluence: atlassian, jira: atlassian } : {}),
    }),
  });
  const slackReaders = new WeakMap<object, boolean>();
  const githubReaders = new WeakMap<object, boolean>();
  const atlassianReaders = new WeakMap<object, boolean>();
  const eligibility = (tx: Transaction) =>
    searchEligibility(
      tx.schema,
      !!google,
      slackReaders.get(tx.client) === true,
      githubReaders.get(tx.client) === true,
      atlassianReaders.get(tx.client) === true,
      tx.commonVersion >= 1,
    );
  const processing = new Set<Promise<unknown>>();
  async function transaction<T>(
    workspaceId: string,
    userId: string,
    deadlineAt: number,
    write: boolean,
    operation: (tx: Transaction, actor: HumanActor) => Promise<T>,
  ) {
    const compatibility = { ...commonCompatibility, deadlineAt };
    return runtime.transaction(workspaceId, compatibility, async raw => {
      const tx = store.bind(raw);
      await lockAuthorization(tx, write ? 'write' : 'read');
      const actor = await resolveHuman(tx, userId);
      await currentMember(tx, actor);
      // Slack SQL is planned only for members selected into at least one Slack source.
      slackReaders.set(
        tx.client,
        !!slack &&
          !!(
            await tx.client.query(`SELECT 1 FROM ${table(tx, 'slack_members')} WHERE membership_id=$1 LIMIT 1`, [
              actor.membershipId,
            ])
          ).rowCount,
      );
      // GitHub SQL follows the same rule for members selected into at least one GitHub source.
      githubReaders.set(
        tx.client,
        !!github &&
          !!(
            await tx.client.query(`SELECT 1 FROM ${table(tx, 'github_members')} WHERE membership_id=$1 LIMIT 1`, [
              actor.membershipId,
            ])
          ).rowCount,
      );
      // Atlassian SQL is planned only for members selected into at least one Confluence or Jira source.
      atlassianReaders.set(
        tx.client,
        !!atlassian &&
          !!(
            await tx.client.query(`SELECT 1 FROM ${table(tx, 'atlassian_members')} WHERE membership_id=$1 LIMIT 1`, [
              actor.membershipId,
            ])
          ).rowCount,
      );
      return operation(tx, actor);
    });
  }
  async function lexical(
    workspaceId: string,
    userId: string,
    query: string,
    filters: KnowledgeSearchFilters,
    typing: boolean,
    deadlineAt: number,
    allowKeywordFallback = false,
  ) {
    return transaction(workspaceId, userId, deadlineAt, false, async (tx, actor) => {
      const prefix = (query.match(/[\p{L}\p{N}]+/gu) ?? [])
        .slice(0, 8)
        .map(word => `${word.slice(0, 64)}:*`)
        .join(' & ');
      // Load eligibility once, then drive matching from the GIN indexes with a hashed publication filter.
      // A join against the eligibility CTE is misestimated as one row and scans every eligible chunk.
      const eligible = z.array(eligibleLexicalSchema).parse(
        (
          await tx.client.query(
            `SELECT e.document_id,e.source_id,e.revision_id,e.publication_id,e.access_epoch,
          (v.id IS NOT NULL) AS semantic FROM (${eligibility(tx)}) e LEFT JOIN ${table(tx, 'vector_publications')} v
          ON v.id=e.vector_publication_id AND v.lexical_publication_id=e.publication_id AND v.revision_id=e.revision_id AND v.profile_id=$6`,
            [...values(actor, filters), knowledgeEmbeddingProfile.id],
          )
        ).rows,
      );
      const coverage = { lexical: eligible.length, semantic: eligible.filter(row => row.semantic).length };
      const byPublication = new Map(eligible.map(row => [row.publication_id, row]));
      const match = async (broaden: boolean) =>
        eligible.length
          ? z.array(lexicalMatchSchema).parse(
              (
                await tx.client.query(
                  `WITH q AS (SELECT CASE WHEN $3::boolean THEN to_tsquery('english',$2) ELSE ${
                    broaden
                      ? "(SELECT string_agg(quote_literal(lexeme),' | ')::tsquery FROM unnest(tsvector_to_array(to_tsvector('english',$1))) words(lexeme))"
                      : "websearch_to_tsquery('english',$1)"
                  } END AS query),
        matches AS (SELECT k.publication_id,k.ordinal,k.identifiers @> ARRAY[$4]::text[] AS exact,ts_rank_cd(k.search_vector,q.query) AS rank
          FROM ${table(tx, 'chunks')} k CROSS JOIN q
          WHERE (k.search_vector @@ q.query OR k.identifiers @> ARRAY[$4]::text[]) AND k.publication_id=ANY($5::uuid[])),
        best AS (SELECT DISTINCT ON (publication_id) * FROM matches ORDER BY publication_id,exact DESC,rank DESC,ordinal)
        SELECT best.* FROM best${
          byPublication.size > 200
            ? `
          JOIN ${table(tx, 'publications')} p ON p.id=best.publication_id
          ORDER BY best.exact DESC,best.rank DESC,p.document_id,best.ordinal LIMIT 200`
            : ''
        }`,
                  [query, prefix, typing, normalizeIdentifier(query), [...byPublication.keys()]],
                )
              ).rows,
            )
          : [];
      let matched = await match(false);
      let broadened = false;
      // Preserve explicit phrases, exclusions and OR syntax; only widen plain topic queries with no strict match.
      if (allowKeywordFallback && !typing && !matched.length && !/"|(?:^|\s)-\S|\bor\b/i.test(query)) {
        matched = await match(true);
        broadened = matched.length > 0;
      }
      const candidates = matched
        .flatMap(row => {
          const owner = byPublication.get(row.publication_id);
          return owner ? [{ row, owner }] : [];
        })
        .sort(
          (a, b) =>
            Number(b.row.exact) - Number(a.row.exact) ||
            b.row.rank - a.row.rank ||
            (a.owner.document_id < b.owner.document_id
              ? -1
              : a.owner.document_id > b.owner.document_id
                ? 1
                : a.row.ordinal - b.row.ordinal),
        )
        .map(({ row, owner }) => ({
          document_id: owner.document_id,
          source_id: owner.source_id,
          revision_id: owner.revision_id,
          publication_id: owner.publication_id,
          access_epoch: owner.access_epoch,
          ordinal: row.ordinal,
          vector_publication_id: null,
          exact: row.exact,
          ...(broadened ? { broadened: true } : {}),
        }));
      const unavailable =
        google && filters.kinds.includes('google')
          ? z.object({ unavailable: z.boolean() }).parse(
              (
                await tx.client.query(
                  `SELECT EXISTS (
        SELECT 1 FROM ${table(tx, 'google_members')} a JOIN ${table(tx, 'sources')} s ON s.id=a.source_id
        WHERE a.membership_id=$1 AND s.state<>'removed' AND (cardinality($2::uuid[])=0 OR s.id=ANY($2::uuid[]))
          AND (NOT EXISTS (SELECT 1 FROM ${table(tx, 'google_readers')} r WHERE r.source_id=s.id AND r.membership_id=$1)
          OR EXISTS (SELECT 1 FROM ${table(tx, 'documents')} d WHERE d.source_id=s.id AND d.tombstoned_at IS NULL
            AND (cardinality($3::uuid[])=0 OR d.id=ANY($3::uuid[])) AND NOT EXISTS (
              SELECT 1 FROM ${table(tx, 'google_eligible')} e WHERE e.document_id=d.id AND e.membership_id=$1)))) AS unavailable`,
                  [actor.membershipId, filters.sourceIds, filters.documentIds],
                )
              ).rows[0],
            ).unavailable
          : false;
      const slackUnavailable =
        slackReaders.get(tx.client) === filters.kinds.includes('slack')
          ? z.object({ unavailable: z.boolean() }).parse(
              (
                await tx.client.query(
                  `WITH readable AS MATERIALIZED (SELECT document_id FROM ${table(tx, 'slack_eligible_for')}($1::uuid,$4::text))
        SELECT EXISTS (
        SELECT 1 FROM ${table(tx, 'slack_members')} a JOIN ${table(tx, 'sources')} s ON s.id=a.source_id
        WHERE a.membership_id=$1 AND s.state<>'removed' AND (cardinality($2::uuid[])=0 OR s.id=ANY($2::uuid[]))
          AND (EXISTS (SELECT 1 FROM ${table(tx, 'slack_conversations')} c WHERE c.source_id=s.id AND c.state<>'active')
          OR EXISTS (SELECT 1 FROM ${table(tx, 'documents')} d WHERE d.source_id=s.id AND d.tombstoned_at IS NULL
            AND (cardinality($3::uuid[])=0 OR d.id=ANY($3::uuid[])) AND NOT EXISTS (
              SELECT 1 FROM readable e WHERE e.document_id=d.id)))) AS unavailable`,
                  [actor.membershipId, filters.sourceIds, filters.documentIds, actor.userId],
                )
              ).rows[0],
            ).unavailable
          : false;
      const githubUnavailable =
        githubReaders.get(tx.client) === filters.kinds.includes('github')
          ? z.object({ unavailable: z.boolean() }).parse(
              (
                await tx.client.query(
                  `WITH readable AS MATERIALIZED (SELECT document_id FROM ${table(tx, 'github_eligible_for')}($1::uuid,$4::text))
        SELECT EXISTS (
        SELECT 1 FROM ${table(tx, 'github_members')} a JOIN ${table(tx, 'sources')} s ON s.id=a.source_id
        WHERE a.membership_id=$1 AND s.state<>'removed' AND (cardinality($2::uuid[])=0 OR s.id=ANY($2::uuid[]))
          AND (EXISTS (SELECT 1 FROM ${table(tx, 'github_repositories')} c WHERE c.source_id=s.id AND c.state<>'active')
          OR EXISTS (SELECT 1 FROM ${table(tx, 'documents')} d WHERE d.source_id=s.id AND d.tombstoned_at IS NULL
            AND (cardinality($3::uuid[])=0 OR d.id=ANY($3::uuid[])) AND NOT EXISTS (
              SELECT 1 FROM readable e WHERE e.document_id=d.id)))) AS unavailable`,
                  [actor.membershipId, filters.sourceIds, filters.documentIds, actor.userId],
                )
              ).rows[0],
            ).unavailable
          : false;
      const atlassianUnavailable =
        atlassianReaders.get(tx.client) === (filters.kinds.includes('confluence') || filters.kinds.includes('jira'))
          ? z.object({ unavailable: z.boolean() }).parse(
              (
                await tx.client.query(
                  `WITH readable AS MATERIALIZED (SELECT document_id FROM ${table(tx, 'atlassian_eligible_for')}($1::uuid,$4::text))
        SELECT EXISTS (
        SELECT 1 FROM ${table(tx, 'atlassian_members')} a JOIN ${table(tx, 'sources')} s ON s.id=a.source_id
        WHERE a.membership_id=$1 AND s.state<>'removed' AND s.provider=ANY($5::text[]) AND (cardinality($2::uuid[])=0 OR s.id=ANY($2::uuid[]))
          AND (EXISTS (SELECT 1 FROM ${table(tx, 'atlassian_targets')} t WHERE t.source_id=s.id AND t.state<>'active')
          OR EXISTS (SELECT 1 FROM ${table(tx, 'documents')} d WHERE d.source_id=s.id AND d.tombstoned_at IS NULL
            AND (cardinality($3::uuid[])=0 OR d.id=ANY($3::uuid[])) AND NOT EXISTS (
              SELECT 1 FROM readable e WHERE e.document_id=d.id)))) AS unavailable`,
                  [actor.membershipId, filters.sourceIds, filters.documentIds, actor.userId, filters.kinds],
                )
              ).rows[0],
            ).unavailable
          : false;
      return {
        candidates: z.array(candidateSchema).parse(candidates),
        coverage,
        unavailable: unavailable || slackUnavailable || githubUnavailable || atlassianUnavailable,
      };
    });
  }
  async function semantic(
    workspaceId: string,
    userId: string,
    filters: KnowledgeSearchFilters,
    vector: number[],
    deadlineAt: number,
  ) {
    return transaction(workspaceId, userId, deadlineAt, false, async (tx, actor) => {
      // Load eligible publications first. Joining the eligibility CTE inside the vector query lets the
      // planner misestimate it as one row and replace the HNSW scan with a brute-force distance sort.
      const eligible = z.array(eligibleVectorSchema).parse(
        (
          await tx.client.query(
            `SELECT e.document_id,e.source_id,e.revision_id,e.publication_id,e.access_epoch,e.vector_publication_id
        FROM (${eligibility(tx)}) e JOIN ${table(tx, 'vector_publications')} p
          ON p.id=e.vector_publication_id AND p.revision_id=e.revision_id AND p.lexical_publication_id=e.publication_id AND p.profile_id=$6`,
            [...values(actor, filters), knowledgeEmbeddingProfile.id],
          )
        ).rows,
      );
      if (!eligible.length) return [];
      const byVector = new Map(eligible.map(row => [row.vector_publication_id, row]));
      const ids = [...byVector.keys()];
      const query = JSON.stringify(vector);
      const count = z.object({ count: z.number() }).parse(
        (
          await tx.client.query(
            `SELECT count(*)::int AS count FROM (SELECT 1 FROM ${table(tx, 'search_vectors')}
        WHERE profile_id=$1 AND vector_publication_id=ANY($2::uuid[]) LIMIT 2049) subset`,
            [knowledgeEmbeddingProfile.id, ids],
          )
        ).rows[0],
      ).count;
      const exact = count <= 2048;
      if (!exact)
        await tx.client.query(
          "SELECT set_config('hnsw.iterative_scan','strict_order',true),set_config('hnsw.ef_search','200',true),set_config('hnsw.max_scan_tuples','20000',true)",
        );
      const sql = exact
        ? `SELECT DISTINCT ON (lexical_publication_id) vector_publication_id,lexical_publication_id,ordinal,embedding OPERATOR(extensions.<=>) $3::extensions.vector(1536) AS distance
            FROM ${table(tx, 'search_vectors')} WHERE profile_id=$1 AND vector_publication_id=ANY($2::uuid[])
            ORDER BY lexical_publication_id,distance,ordinal`
        : `SELECT vector_publication_id,lexical_publication_id,ordinal,embedding OPERATOR(extensions.<=>) $3::extensions.vector(1536) AS distance
            FROM ${table(tx, 'search_vectors')} WHERE profile_id=$1 AND vector_publication_id=ANY($2::uuid[]) AND NOT(lexical_publication_id=ANY($4::uuid[]))
            ORDER BY embedding OPERATOR(extensions.<=>) $3::extensions.vector(1536) LIMIT 2000`;
      const documents = new Set<string>();
      const candidates: Candidate[] = [];
      for (let attempt = 0; attempt < 3; attempt++) {
        const rows = z
          .array(nearestSchema)
          .parse(
            (
              await tx.client.query(
                sql,
                exact
                  ? [knowledgeEmbeddingProfile.id, ids, query]
                  : [knowledgeEmbeddingProfile.id, ids, query, candidates.map(candidate => candidate.publication_id)],
              )
            ).rows,
          );
        const ranked = rows
          .flatMap(row => {
            const owner = byVector.get(row.vector_publication_id);
            return owner && owner.publication_id === row.lexical_publication_id ? [{ row, owner }] : [];
          })
          .sort(
            (a, b) =>
              a.row.distance - b.row.distance ||
              (a.owner.document_id < b.owner.document_id
                ? -1
                : a.owner.document_id > b.owner.document_id
                  ? 1
                  : a.row.ordinal - b.row.ordinal),
          );
        for (const { row, owner } of ranked)
          if (!documents.has(owner.document_id)) {
            documents.add(owner.document_id);
            candidates.push({
              document_id: owner.document_id,
              source_id: owner.source_id,
              revision_id: owner.revision_id,
              publication_id: owner.publication_id,
              access_epoch: owner.access_epoch,
              ordinal: row.ordinal,
              vector_publication_id: row.vector_publication_id,
              exact: false,
            });
          }
        if (exact || candidates.length >= 100 || rows.length < 2000) break;
      }
      return candidates.slice(0, 200);
    });
  }
  async function readSession(workspaceId: string, userId: string, id: string, deadlineAt: number) {
    return transaction(workspaceId, userId, deadlineAt, false, async (tx, actor) =>
      sessionSchema
        .optional()
        .parse(
          (
            await tx.client.query(
              `SELECT * FROM ${table(tx, 'search_sessions')} WHERE id=$1 AND owner_membership_id=$2 AND owner_user_id=$3 AND expires_at>clock_timestamp()`,
              [id, actor.membershipId, actor.userId],
            )
          ).rows[0],
        ),
    );
  }
  async function page(
    workspaceId: string,
    userId: string,
    session: Session,
    offset: number,
    deadlineAt: number,
    persist: boolean,
  ): Promise<KnowledgeSearchResult> {
    return transaction(workspaceId, userId, deadlineAt, persist, async (tx, actor) => {
      if (session.expires_at.getTime() <= Date.now()) throw new KnowledgeError('superseded');
      if (persist) {
        await tx.client.query(
          `DELETE FROM ${table(tx, 'search_sessions')} WHERE id IN (SELECT id FROM ${table(tx, 'search_sessions')} WHERE expires_at<=clock_timestamp() ORDER BY expires_at LIMIT 100)`,
        );
        const count = z
          .object({ count: z.number() })
          .parse(
            (
              await tx.client.query(
                `SELECT count(*)::int AS count FROM ${table(tx, 'search_sessions')} WHERE owner_membership_id=$1`,
                [actor.membershipId],
              )
            ).rows[0],
          ).count;
        if (count >= 100)
          await tx.client.query(
            `DELETE FROM ${table(tx, 'search_sessions')} WHERE (id,owner_membership_id) IN
          (SELECT id,owner_membership_id FROM ${table(tx, 'search_sessions')} WHERE owner_membership_id=$1 ORDER BY expires_at,id LIMIT 1)`,
            [actor.membershipId],
          );
        await tx.client.query(
          `INSERT INTO ${table(tx, 'search_sessions')} (id,owner_membership_id,owner_user_id,fingerprint,filters,candidates,mode,reason,coverage,expires_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`,
          [
            session.id,
            actor.membershipId,
            actor.userId,
            session.fingerprint,
            session.filters,
            JSON.stringify(session.candidates),
            session.mode,
            session.reason,
            session.coverage,
            session.expires_at,
          ],
        );
        const existing = sessionSchema.parse(
          (
            await tx.client.query(
              `SELECT * FROM ${table(tx, 'search_sessions')} WHERE id=$1 AND owner_membership_id=$2 AND owner_user_id=$3`,
              [session.id, actor.membershipId, actor.userId],
            )
          ).rows[0],
        );
        if (existing.fingerprint !== session.fingerprint) throw new KnowledgeError('conflict');
        session = existing;
      }
      const rows = z
        .array(
          z
            .object({
              position: z.number(),
              title: z.string(),
              passage: z.string(),
              heading: z.string(),
              expires_at: z.date().nullable(),
              file_id: uuidSchema.nullable(),
            })
            .extend(candidateSchema.shape),
        )
        .parse(
          (
            await tx.client.query(
              `WITH eligible AS MATERIALIZED (
          SELECT e.* FROM (${eligibility(tx)}) e WHERE e.document_id=ANY($9::uuid[])),
        candidates AS (SELECT c.*, (a.ordinality-1)::int AS position FROM jsonb_array_elements($6::jsonb) WITH ORDINALITY a(value,ordinality)
          CROSS JOIN LATERAL jsonb_to_record(a.value) AS c(document_id uuid,source_id uuid,revision_id uuid,publication_id uuid,access_epoch int,ordinal int,vector_publication_id uuid,exact boolean))
        SELECT c.*,e.expires_at,k.search_title AS title,k.heading,left(k.passage,2400) AS passage,
          CASE WHEN r.original->>'kind'='file' THEN (r.original->>'fileId')::uuid END AS file_id FROM candidates c
          JOIN eligible e ON e.document_id=c.document_id AND e.source_id=c.source_id AND e.revision_id=c.revision_id
            AND e.publication_id=c.publication_id AND e.access_epoch=c.access_epoch
          JOIN ${table(tx, 'revisions')} r ON r.id=c.revision_id
          JOIN ${table(tx, 'chunks')} k ON k.publication_id=c.publication_id AND k.ordinal=c.ordinal
          WHERE c.position >= $7 AND (c.vector_publication_id IS NULL OR (e.vector_publication_id=c.vector_publication_id AND EXISTS (
            SELECT 1 FROM ${table(tx, 'vector_publications')} p WHERE p.id=c.vector_publication_id AND p.lexical_publication_id=c.publication_id
              AND p.revision_id=c.revision_id AND p.profile_id=$8))) ORDER BY c.position LIMIT 20`,
              [
                ...values(actor, session.filters),
                JSON.stringify(session.candidates),
                offset,
                knowledgeEmbeddingProfile.id,
                session.candidates.slice(offset).map(candidate => candidate.document_id),
              ],
            )
          ).rows,
        );
      await currentMember(tx, actor);
      // Eligibility SQL cannot follow a generated file's recursive sources, so the Files check runs for each file-backed hit.
      const readable = new Map<string, boolean>();
      for (const fileId of new Set(rows.flatMap(row => (row.file_id ? [row.file_id] : [])))) {
        try {
          await requireReadableFile(tx, actor, fileId);
          readable.set(fileId, true);
        } catch (error) {
          if (!(error instanceof AccessDenied) || error instanceof SourceAuthorizationUnavailable) throw error;
          readable.set(fileId, false);
        }
      }
      const authorized = new Set<string>();
      for (const row of rows) {
        if (authorized.has(row.document_id)) continue;
        try {
          await store.eligible(tx, actor, {
            kind: 'knowledge-document',
            workspaceId,
            documentId: row.document_id,
            sourceId: row.source_id,
            revisionId: row.revision_id,
            publicationId: row.publication_id,
            accessEpoch: row.access_epoch,
          });
          authorized.add(row.document_id);
        } catch (error) {
          if (
            !(error instanceof KnowledgeError) &&
            (!(error instanceof AccessDenied) || error instanceof SourceAuthorizationUnavailable)
          )
            throw error;
        }
      }
      const freshRows = rows.filter(
        row =>
          authorized.has(row.document_id) &&
          (row.expires_at === null || row.expires_at.getTime() > Date.now()) &&
          (row.file_id === null || readable.get(row.file_id)),
      );
      const hits = freshRows.map(row => ({
        title: row.title,
        heading: row.heading,
        text: row.passage,
        citation: knowledgeCitationSchema.parse({
          kind: 'knowledge-document',
          workspaceId,
          documentId: row.document_id,
          sourceId: row.source_id,
          revisionId: row.revision_id,
          publicationId: row.publication_id,
          accessEpoch: row.access_epoch,
          ordinal: row.ordinal,
        }),
      }));
      const next =
        rows.length === 20 ? (rows.at(-1)?.position ?? session.candidates.length) + 1 : session.candidates.length;
      return {
        hits,
        mode: session.mode,
        reason: session.reason,
        ...(session.candidates.some(candidate => candidate.broadened) ? { queryBroadened: true } : {}),
        coverage:
          freshRows.length < rows.length ||
          (rows.length < Math.min(20, session.candidates.length - offset) && session.coverage === 'complete')
            ? 'partial'
            : session.coverage,
        bounded: true,
        continuation: next < session.candidates.length ? `${session.id}:${next}` : null,
        validUntil: new Date(
          Math.min(
            session.expires_at.getTime(),
            Date.now() + 300000,
            ...freshRows.flatMap(row => (row.expires_at ? [row.expires_at.getTime()] : [])),
          ),
        ).toISOString(),
      };
    });
  }
  async function search(
    workspaceId: string,
    userId: string,
    value: unknown,
    requestDeadline = Date.now() + defaultCallTimeoutMs,
    signal?: AbortSignal,
    attribution?: { taskFlowId?: string; allowKeywordFallback?: boolean },
  ): Promise<KnowledgeSearchResult> {
    const deadlineAt = Math.min(requestDeadline, Date.now() + defaultCallTimeoutMs);
    const input = knowledgeSearchRequestSchema.parse(value);
    signal?.throwIfAborted();
    if (input.kind === 'continue') {
      const [id, position] = input.continuation.split(':');
      const session = await readSession(workspaceId, userId, uuidSchema.parse(id), deadlineAt);
      if (!session) throw new KnowledgeError('superseded');
      return page(workspaceId, userId, session, Number(position), deadlineAt, false);
    }
    const filters = {
      kinds: [...new Set(input.filters.kinds)].sort(),
      sourceIds: [...new Set(input.filters.sourceIds)].sort(),
      documentIds: [...new Set(input.filters.documentIds)].sort(),
    };
    const hash = fingerprint({
      query: input.query,
      filters,
      ...(attribution?.allowKeywordFallback ? { allowKeywordFallback: true } : {}),
    });
    if (input.kind === 'submitted') {
      const previous = await readSession(workspaceId, userId, input.commandId, deadlineAt);
      if (previous) {
        if (previous.fingerprint !== hash) throw new KnowledgeError('conflict');
        return page(workspaceId, userId, previous, 0, deadlineAt, false);
      }
    }
    const lexicalResult = await lexical(
      workspaceId,
      userId,
      input.query,
      filters,
      input.kind === 'typing',
      deadlineAt - 400,
      attribution?.allowKeywordFallback,
    );
    let semanticCandidates: Candidate[] = [];
    let reason: KnowledgeSearchResult['reason'] = input.kind === 'typing' ? 'typing' : 'no-semantic-content';
    let hybrid = false;
    if (input.kind === 'submitted' && lexicalResult.coverage.semantic > 0 && Date.now() < deadlineAt - 600) {
      try {
        signal?.throwIfAborted();
        const prepared = await embeddings.prepareSearchQuery(workspaceId, userId, {
          commandId: input.commandId,
          query: input.query,
          filters,
          deadlineAt: deadlineAt - 550,
          retrySemantic: input.retrySemantic,
          taskFlowId: attribution?.taskFlowId,
        });
        const cancel = () => {
          void embeddings.cancelSearchQuery(workspaceId, userId, prepared.commandId).catch(() => undefined);
        };
        if (signal?.aborted) {
          cancel();
          signal.throwIfAborted();
        }
        signal?.addEventListener('abort', cancel, { once: true });
        let status = prepared;
        if (status.state === 'queued' || status.state === 'capacity-blocked') {
          const pending = embeddings.process(
            { workspaceId, jobId: prepared.jobId, generation: prepared.generation },
            deadlineAt - 550,
            signal,
          );
          processing.add(pending);
          void pending.then(
            () => {
              processing.delete(pending);
              signal?.removeEventListener('abort', cancel);
            },
            () => {
              processing.delete(pending);
              signal?.removeEventListener('abort', cancel);
            },
          );
          await until(pending, deadlineAt - 550);
          status = await embeddings.queryStatus(workspaceId, userId, prepared.commandId, deadlineAt - 500);
        } else signal?.removeEventListener('abort', cancel);
        while (status.state === 'busy' && Date.now() < deadlineAt - 650) {
          await delay(25);
          status = await embeddings.queryStatus(workspaceId, userId, prepared.commandId, deadlineAt - 550);
        }
        if (status.state === 'ready' && status.vector?.some(value => value !== 0)) {
          semanticCandidates = await semantic(workspaceId, userId, filters, status.vector, deadlineAt - 350);
          hybrid = true;
          reason = null;
        } else
          reason =
            status.state === 'disabled'
              ? 'semantic-not-enabled'
              : status.state === 'credits-blocked'
                ? 'credits-blocked'
                : status.state === 'capacity-blocked'
                  ? 'capacity-blocked'
                  : status.state === 'busy' || status.state === 'queued'
                    ? 'embedding-pending'
                    : 'provider-unavailable';
      } catch (error) {
        if (error instanceof KnowledgeError && error.code === 'conflict') throw error;
        if (
          error instanceof StorageUnavailableError &&
          ['wait_timeout', 'queue_full', 'pool_capacity'].includes(error.code)
        )
          reason = 'deadline';
        else if (error instanceof Error && 'code' in error && (error.code === '57014' || error.code === '55P03'))
          reason = 'deadline';
        else throw error;
      }
    }
    const session: Session = {
      id: input.kind === 'submitted' ? input.commandId : randomUUID(),
      fingerprint: hash,
      filters,
      candidates: fuseKnowledgeCandidates(lexicalResult.candidates, semanticCandidates),
      mode: hybrid ? 'hybrid' : 'keyword-only',
      reason,
      coverage: lexicalResult.unavailable
        ? 'partial'
        : hybrid
          ? lexicalResult.coverage.lexical === lexicalResult.coverage.semantic
            ? 'complete'
            : 'partial'
          : 'keyword-only',
      expires_at: new Date(Date.now() + 300000),
    };
    const result = await page(workspaceId, userId, session, 0, deadlineAt, input.kind === 'submitted');
    return input.kind === 'typing' ? { ...result, continuation: null } : result;
  }
  return {
    search,
    close: async () => {
      await Promise.allSettled(processing);
    },
  };
}
