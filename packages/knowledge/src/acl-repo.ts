/**
 * Storage for Knowledge ACL entries. Grants naming a group are stored as the group and never
 * flattened into its members. The projection of stored Pages into gate subjects, and Principal
 * expansion, live in `./subject-store`.
 */

import type { Queryable } from "@tulipfarm/storage";
import { canonicalKnowledgeId } from "./ids";
import type { KnowledgeAclEntry, KnowledgeSubjectKind } from "./subject";

export const ENTRY_COLS =
  "business_id, subject_kind, subject_id, principal_kind, principal_id, effect, capability, origin, provider, acl_revision, captured_at";

export function rowToEntry(row: Record<string, unknown>): KnowledgeAclEntry {
  return {
    subjectKind: row.subject_kind as KnowledgeSubjectKind,
    subjectId: row.subject_id as string,
    principal: { kind: row.principal_kind as string, id: row.principal_id as string },
    effect: row.effect as KnowledgeAclEntry["effect"],
    capability: row.capability as KnowledgeAclEntry["capability"],
  };
}

export interface KnowledgeAclEntryInput extends KnowledgeAclEntry {
  readonly businessId: string;
  readonly origin?: "authored" | "synced";
  readonly provider?: string;
  readonly aclRevision?: string;
}

export interface KnowledgeAclRepo {
  put(entry: KnowledgeAclEntryInput): Promise<void>;
  /** Entries on one subject only; inheritance is applied by the subject store, not here. */
  listForSubject(
    businessId: string,
    subjectKind: KnowledgeSubjectKind,
    subjectId: string
  ): Promise<readonly KnowledgeAclEntry[]>;
  remove(
    businessId: string,
    subjectKind: KnowledgeSubjectKind,
    subjectId: string,
    principal: KnowledgeAclEntry["principal"]
  ): Promise<void>;
  /** Drops every entry on a subject. Used when the subject itself is deleted. */
  removeSubject(
    businessId: string,
    subjectKind: KnowledgeSubjectKind,
    subjectId: string
  ): Promise<number>;
}

export class PgKnowledgeAclRepo implements KnowledgeAclRepo {
  constructor(private readonly q: Queryable) {}

  async put(entry: KnowledgeAclEntryInput): Promise<void> {
    await this.q.query(
      `INSERT INTO knowledge_acl_entries (${ENTRY_COLS})
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
       ON CONFLICT (business_id, subject_kind, subject_id, principal_kind, principal_id, capability)
       DO UPDATE SET
         effect = EXCLUDED.effect,
         origin = EXCLUDED.origin,
         provider = EXCLUDED.provider,
         acl_revision = EXCLUDED.acl_revision,
         captured_at = now(),
         updated_at = now()`,
      [
        entry.businessId,
        entry.subjectKind,
        canonicalKnowledgeId(entry.subjectId),
        entry.principal.kind,
        entry.principal.id,
        entry.effect,
        entry.capability,
        entry.origin ?? "authored",
        entry.provider ?? null,
        entry.aclRevision ?? "1",
      ]
    );
  }

  async listForSubject(
    businessId: string,
    subjectKind: KnowledgeSubjectKind,
    subjectId: string
  ): Promise<readonly KnowledgeAclEntry[]> {
    const { rows } = await this.q.query(
      `SELECT ${ENTRY_COLS} FROM knowledge_acl_entries
        WHERE business_id = $1 AND subject_kind = $2 AND lower(subject_id) = $3
        ORDER BY principal_kind, principal_id`,
      [businessId, subjectKind, canonicalKnowledgeId(subjectId)]
    );
    return rows.map(rowToEntry);
  }

  async remove(
    businessId: string,
    subjectKind: KnowledgeSubjectKind,
    subjectId: string,
    principal: KnowledgeAclEntry["principal"]
  ): Promise<void> {
    await this.q.query(
      `DELETE FROM knowledge_acl_entries
        WHERE business_id = $1 AND subject_kind = $2 AND lower(subject_id) = $3
          AND principal_kind = $4 AND principal_id = $5`,
      [businessId, subjectKind, canonicalKnowledgeId(subjectId), principal.kind, principal.id]
    );
  }

  async removeSubject(
    businessId: string,
    subjectKind: KnowledgeSubjectKind,
    subjectId: string
  ): Promise<number> {
    const { rows } = await this.q.query<{ deleted: number }>(
      `DELETE FROM knowledge_acl_entries
        WHERE business_id = $1 AND subject_kind = $2 AND lower(subject_id) = $3
        RETURNING 1 AS deleted`,
      [businessId, subjectKind, canonicalKnowledgeId(subjectId)]
    );
    return rows.length;
  }
}

export {
  type AclLevelRef,
  type PageVisibilityScope,
  type PageVisibilitySource,
  PgKnowledgeSubjectStore,
  PgPrincipalResolver,
} from "./subject-store";
