import type { MemoryScope } from "@tulipfarm/schema";
import type { Queryable } from "@tulipfarm/storage";
import { embeddableText, embedOne, type MemoryEmbedder } from "./embedder";
import type {
  MemoryAssertion,
  MemoryConfirmationState,
  MemoryEraseStoreCounts,
  MemoryEvidenceRef,
  MemoryOrigin,
  MemoryScopeFilter,
  MemoryStatus,
  MemoryStore,
  MemoryTrustTier,
  MemoryType,
} from "./memory";
import type { MemoryScopeTarget } from "./scope";

/**
 * Durable `MemoryStore` over `memory_assertions` + `memory_evidence`. Every read path in the
 * package re-authorizes what this returns, so a store that quietly widened a result would defeat
 * that — hence `listActiveForScope` filters on the owner columns rather than trusting a caller to
 * narrow afterwards.
 */

interface AssertionRow {
  business_id: string;
  assertion_id: string;
  scope: string;
  subject_principal_id: string | null;
  agent_id: string | null;
  role_id: string | null;
  run_id: string | null;
  subject: string;
  statement: string;
  memory_type: string;
  trust_tier: string;
  confidence: number;
  importance: number;
  origin: string;
  author_principal_id: string;
  author_agent_id: string | null;
  provenance_run_id: string | null;
  confirmation: string;
  status: string;
  version: number;
  created_at: Date;
  updated_at: Date;
  recorded_until: Date | null;
  valid_from: Date;
  valid_to: Date | null;
  expires_at: Date | null;
  supersedes_id: string | null;
  superseded_by_id: string | null;
  entities: string[] | null;
  access_count: number;
  last_accessed_at: Date | null;
}

interface EvidenceRow {
  assertion_id: string;
  kind: string;
  ref: string;
  source_id: string | null;
  revision: string | null;
}

const COLUMNS = `business_id, assertion_id, scope, subject_principal_id, agent_id, role_id, run_id,
  subject, statement, memory_type, trust_tier, confidence, importance, origin,
  author_principal_id, author_agent_id, provenance_run_id, confirmation, status, version,
  created_at, updated_at, recorded_until, valid_from, valid_to, expires_at,
  supersedes_id, superseded_by_id, entities, access_count, last_accessed_at`;

function targetFromRow(row: AssertionRow): MemoryScopeTarget {
  return {
    scope: row.scope as MemoryScope,
    businessId: row.business_id,
    ...(row.subject_principal_id === null ? {} : { subjectPrincipalId: row.subject_principal_id }),
    ...(row.agent_id === null ? {} : { agentId: row.agent_id }),
    ...(row.role_id === null ? {} : { roleId: row.role_id }),
    ...(row.run_id === null ? {} : { runId: row.run_id }),
  };
}

function evidenceFromRow(row: EvidenceRow): MemoryEvidenceRef {
  return {
    kind: row.kind as MemoryEvidenceRef["kind"],
    ref: row.ref,
    ...(row.source_id === null ? {} : { sourceId: row.source_id }),
    ...(row.revision === null ? {} : { revision: row.revision }),
  };
}

function assertionFromRow(
  row: AssertionRow,
  evidence: readonly MemoryEvidenceRef[]
): MemoryAssertion {
  return {
    assertionId: row.assertion_id,
    businessId: row.business_id,
    target: targetFromRow(row),
    subject: row.subject,
    statement: row.statement,
    memoryType: row.memory_type as MemoryType,
    trustTier: row.trust_tier as MemoryTrustTier,
    confidence: row.confidence,
    importance: row.importance,
    provenance: {
      origin: row.origin as MemoryOrigin,
      authorPrincipalId: row.author_principal_id,
      ...(row.author_agent_id === null ? {} : { authorAgentId: row.author_agent_id }),
      ...(row.provenance_run_id === null ? {} : { runId: row.provenance_run_id }),
      evidence,
    },
    confirmation: row.confirmation as MemoryConfirmationState,
    status: row.status as MemoryStatus,
    version: row.version,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    ...(row.recorded_until === null ? {} : { recordedUntil: row.recorded_until.toISOString() }),
    validFrom: row.valid_from.toISOString(),
    ...(row.valid_to === null ? {} : { validTo: row.valid_to.toISOString() }),
    ...(row.expires_at === null ? {} : { expiresAt: row.expires_at.toISOString() }),
    ...(row.supersedes_id === null ? {} : { supersedesId: row.supersedes_id }),
    ...(row.superseded_by_id === null ? {} : { supersededById: row.superseded_by_id }),
    entities: row.entities ?? [],
    accessCount: row.access_count,
    ...(row.last_accessed_at === null
      ? {}
      : { lastAccessedAt: row.last_accessed_at.toISOString() }),
  };
}

export class PgMemoryAssertionStore implements MemoryStore {
  constructor(
    private readonly db: Queryable,
    private readonly embedder?: MemoryEmbedder
  ) {}

  /**
   * Index the statement into the dense arm, after the row itself is committed. Best-effort by
   * design: an embedding provider that is absent, slow, or failing must not stop a user from
   * recording a preference.
   */
  private async embedStatement(assertion: MemoryAssertion): Promise<void> {
    if (this.embedder === undefined || !this.embedder.isAvailable()) return;
    if (assertion.status !== "active") return;
    try {
      const active = this.embedder.getActive();
      const embedded = await embedOne(
        this.embedder,
        embeddableText(assertion.subject, assertion.statement)
      );
      if (embedded === undefined) return;
      await this.db.query(
        `UPDATE memory_assertions
            SET embedding = $3::vector, embedding_model = $4, embedding_dim = $5
          WHERE business_id = $1 AND assertion_id = $2`,
        [
          assertion.businessId,
          assertion.assertionId,
          JSON.stringify(embedded.embedding),
          active === null ? null : `${active.provider}:${active.model}`,
          embedded.dimension,
        ]
      );
    } catch {}
  }

  /**
   * Upsert the assertion and replace its evidence wholesale. Evidence is delete-then-insert rather
   * than merged: an edit that dropped a citation must drop the row too, or a later recall would
   * re-authorize a source the assertion no longer rests on and could keep serving a statement whose
   * real basis is gone.
   */
  async put(assertion: MemoryAssertion): Promise<void> {
    const t = assertion.target;
    await this.db.query(
      `INSERT INTO memory_assertions (${COLUMNS})
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
               $21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31)
       ON CONFLICT (business_id, assertion_id) DO UPDATE SET
         subject = EXCLUDED.subject,
         statement = EXCLUDED.statement,
         memory_type = EXCLUDED.memory_type,
         trust_tier = EXCLUDED.trust_tier,
         confidence = EXCLUDED.confidence,
         importance = EXCLUDED.importance,
         confirmation = EXCLUDED.confirmation,
         status = EXCLUDED.status,
         version = EXCLUDED.version,
         updated_at = EXCLUDED.updated_at,
         recorded_until = EXCLUDED.recorded_until,
         valid_from = EXCLUDED.valid_from,
         valid_to = EXCLUDED.valid_to,
         expires_at = EXCLUDED.expires_at,
         supersedes_id = EXCLUDED.supersedes_id,
         superseded_by_id = EXCLUDED.superseded_by_id,
         entities = EXCLUDED.entities,
         access_count = EXCLUDED.access_count,
         last_accessed_at = EXCLUDED.last_accessed_at`,
      [
        assertion.businessId,
        assertion.assertionId,
        t.scope,
        t.subjectPrincipalId ?? null,
        t.agentId ?? null,
        t.roleId ?? null,
        t.runId ?? null,
        assertion.subject,
        assertion.statement,
        assertion.memoryType,
        assertion.trustTier,
        assertion.confidence,
        assertion.importance,
        assertion.provenance.origin,
        assertion.provenance.authorPrincipalId,
        assertion.provenance.authorAgentId ?? null,
        assertion.provenance.runId ?? null,
        assertion.confirmation,
        assertion.status,
        assertion.version,
        assertion.createdAt,
        assertion.updatedAt,
        assertion.recordedUntil ?? null,
        assertion.validFrom,
        assertion.validTo ?? null,
        assertion.expiresAt ?? null,
        assertion.supersedesId ?? null,
        assertion.supersededById ?? null,
        assertion.entities,
        assertion.accessCount,
        assertion.lastAccessedAt ?? null,
      ]
    );

    await this.db.query(
      "DELETE FROM memory_evidence WHERE business_id = $1 AND assertion_id = $2",
      [assertion.businessId, assertion.assertionId]
    );
    for (const [position, item] of assertion.provenance.evidence.entries()) {
      await this.db.query(
        `INSERT INTO memory_evidence (business_id, assertion_id, position, kind, ref, source_id, revision)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          assertion.businessId,
          assertion.assertionId,
          position,
          item.kind,
          item.ref,
          item.sourceId ?? null,
          item.revision ?? null,
        ]
      );
    }

    await this.embedStatement(assertion);
  }

  async get(businessId: string, assertionId: string): Promise<MemoryAssertion | undefined> {
    const { rows } = await this.db.query(
      `SELECT ${COLUMNS} FROM memory_assertions WHERE business_id = $1 AND assertion_id = $2`,
      [businessId, assertionId]
    );
    const row = rows[0] as unknown as AssertionRow | undefined;
    if (row === undefined) return undefined;
    const evidence = await this.evidenceFor(businessId, [assertionId]);
    return assertionFromRow(row, evidence.get(assertionId) ?? []);
  }

  async getMany(
    businessId: string,
    assertionIds: readonly string[]
  ): Promise<readonly MemoryAssertion[]> {
    if (assertionIds.length === 0) return [];
    const found = await this.query(`WHERE business_id = $1 AND assertion_id = ANY($2::text[])`, [
      businessId,
      [...assertionIds],
    ]);
    const byId = new Map(found.map((a) => [a.assertionId, a]));
    const ordered: MemoryAssertion[] = [];
    for (const id of assertionIds) {
      const a = byId.get(id);
      if (a !== undefined) ordered.push(a);
    }
    return ordered;
  }

  async list(businessId: string): Promise<readonly MemoryAssertion[]> {
    return this.query(`WHERE business_id = $1 ORDER BY created_at, assertion_id`, [businessId]);
  }

  async listActive(businessId: string): Promise<readonly MemoryAssertion[]> {
    return this.query(
      `WHERE business_id = $1 AND status = 'active' ORDER BY created_at, assertion_id`,
      [businessId]
    );
  }

  async listActiveForScope(
    businessId: string,
    filter: MemoryScopeFilter
  ): Promise<readonly MemoryAssertion[]> {
    // `IS NOT DISTINCT FROM` so an absent owner id matches NULL — an unqualified filter must not
    return this.query(
      `WHERE business_id = $1
         AND status = 'active'
         AND scope = $2
         AND subject_principal_id IS NOT DISTINCT FROM $3
         AND agent_id IS NOT DISTINCT FROM $4
         AND role_id IS NOT DISTINCT FROM $5
         AND run_id IS NOT DISTINCT FROM $6
       ORDER BY created_at, assertion_id`,
      [
        businessId,
        filter.scope,
        filter.subjectPrincipalId ?? null,
        filter.agentId ?? null,
        filter.roleId ?? null,
        filter.runId ?? null,
      ]
    );
  }

  private async query(where: string, params: unknown[]): Promise<readonly MemoryAssertion[]> {
    const { rows } = await this.db.query(
      `SELECT ${COLUMNS} FROM memory_assertions ${where}`,
      params
    );
    const assertionRows = rows as unknown as AssertionRow[];
    if (assertionRows.length === 0) return [];
    const businessId = assertionRows[0]?.business_id ?? "";
    const evidence = await this.evidenceFor(
      businessId,
      assertionRows.map((r) => r.assertion_id)
    );
    return assertionRows.map((row) => assertionFromRow(row, evidence.get(row.assertion_id) ?? []));
  }

  async erase(assertion: MemoryAssertion): Promise<MemoryEraseStoreCounts> {
    const [evidenceRefs, chunks] = await Promise.all([
      this.countEvidence(assertion.businessId, assertion.assertionId),
      this.countEraseableChunks(assertion),
    ]);

    const episodes = await this.deleteEraseableEpisodes(assertion);
    await this.db.query(
      `UPDATE memory_assertions
          SET supersedes_id = NULL
        WHERE business_id = $1 AND supersedes_id = $2`,
      [assertion.businessId, assertion.assertionId]
    );
    await this.db.query(
      `UPDATE memory_assertions
          SET superseded_by_id = NULL
        WHERE business_id = $1 AND superseded_by_id = $2`,
      [assertion.businessId, assertion.assertionId]
    );
    const { rows } = await this.db.query(
      `DELETE FROM memory_assertions
        WHERE business_id = $1 AND assertion_id = $2
       RETURNING assertion_id`,
      [assertion.businessId, assertion.assertionId]
    );
    const assertions = rows.length;
    return {
      assertions,
      evidenceRefs,
      recallIndexRows: assertions + chunks,
      episodes,
      chunks,
    };
  }

  private async countEvidence(businessId: string, assertionId: string): Promise<number> {
    const { rows } = await this.db.query(
      `SELECT count(*)::text AS n
         FROM memory_evidence
        WHERE business_id = $1 AND assertion_id = $2`,
      [businessId, assertionId]
    );
    return Number((rows as { n: string }[])[0]?.n ?? "0");
  }

  private async countEraseableChunks(assertion: MemoryAssertion): Promise<number> {
    const { rows } = await this.db.query(
      `SELECT count(DISTINCT c.chunk_id)::text AS n
         FROM memory_chunks c
         LEFT JOIN memory_episodes e
           ON e.business_id = c.business_id AND e.episode_id = c.episode_id
        WHERE c.business_id = $1
          AND (
            c.assertion_id = $2
            OR e.assertion_id = $2
            OR ($3 <> '' AND (
              position($3 in c.text) > 0
              OR position($3 in coalesce(e.summary, '')) > 0
              OR position($3 in coalesce(e.outcome, '')) > 0
              OR EXISTS (
                SELECT 1 FROM unnest(coalesce(e.decisions, '{}')) AS decision
                WHERE position($3 in decision) > 0
              )
            ))
          )`,
      [assertion.businessId, assertion.assertionId, assertion.statement]
    );
    return Number((rows as { n: string }[])[0]?.n ?? "0");
  }

  private async deleteEraseableEpisodes(assertion: MemoryAssertion): Promise<number> {
    const { rows: countRows } = await this.db.query(
      `SELECT count(DISTINCT e.episode_id)::text AS n
         FROM memory_episodes e
         LEFT JOIN memory_chunks c
           ON c.business_id = e.business_id AND c.episode_id = e.episode_id
        WHERE e.business_id = $1
          AND (
            e.assertion_id = $2
            OR c.assertion_id = $2
            OR ($3 <> '' AND (
              position($3 in e.summary) > 0
              OR position($3 in e.outcome) > 0
              OR position($3 in coalesce(c.text, '')) > 0
              OR EXISTS (
                SELECT 1 FROM unnest(e.decisions) AS decision
                WHERE position($3 in decision) > 0
              )
            ))
          )`,
      [assertion.businessId, assertion.assertionId, assertion.statement]
    );
    await this.db.query(
      `WITH doomed AS (
         SELECT DISTINCT e.assertion_id
           FROM memory_episodes e
           LEFT JOIN memory_chunks c
             ON c.business_id = e.business_id AND c.episode_id = e.episode_id
          WHERE e.business_id = $1
            AND (
              e.assertion_id = $2
              OR c.assertion_id = $2
              OR ($3 <> '' AND (
                position($3 in e.summary) > 0
                OR position($3 in e.outcome) > 0
                OR position($3 in coalesce(c.text, '')) > 0
                OR EXISTS (
                  SELECT 1 FROM unnest(e.decisions) AS decision
                  WHERE position($3 in decision) > 0
                )
              ))
            )
       )
       DELETE FROM memory_assertions a
        USING doomed d
        WHERE a.business_id = $1
          AND a.assertion_id = d.assertion_id
          AND a.assertion_id <> $2`,
      [assertion.businessId, assertion.assertionId, assertion.statement]
    );
    return Number((countRows as { n: string }[])[0]?.n ?? "0");
  }

  private async evidenceFor(
    businessId: string,
    assertionIds: readonly string[]
  ): Promise<Map<string, MemoryEvidenceRef[]>> {
    const byAssertion = new Map<string, MemoryEvidenceRef[]>();
    if (assertionIds.length === 0) return byAssertion;
    const { rows } = await this.db.query(
      `SELECT assertion_id, kind, ref, source_id, revision
       FROM memory_evidence
       WHERE business_id = $1 AND assertion_id = ANY($2)
       ORDER BY assertion_id, position`,
      [businessId, assertionIds]
    );
    for (const row of rows as unknown as EvidenceRow[]) {
      const list = byAssertion.get(row.assertion_id) ?? [];
      list.push(evidenceFromRow(row));
      byAssertion.set(row.assertion_id, list);
    }
    return byAssertion;
  }
}
