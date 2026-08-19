/**
 * Canonical id shape for Knowledge subjects.
 *
 * Spaces and Pages are `uuid` columns, so a non-UUID id cannot name a row — it makes Postgres raise
 * `invalid input syntax for type uuid` and turns a routine "not found" into a 500. Callers test the
 * shape first so absence has one answer regardless of how the id was malformed.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether `id` can name a Space, Page or Source row at all. */
export function isKnowledgeId(id: string | undefined | null): id is string {
  return typeof id === "string" && UUID_RE.test(id);
}

/**
 * The one spelling of `id` that the `uuid` columns resolve to.
 *
 * Subject ids are compared as `text` in `knowledge_acl_entries` but as `uuid` everywhere they name
 * a row, and those two equalities disagree on case. Anything comparing a subject id against stored
 * ACL state must canonicalize first or the gate answers for a different row than the one the
 * caller reaches. Non-UUID ids are returned untouched — their case may be significant.
 */
export function canonicalKnowledgeId(id: string): string {
  return isKnowledgeId(id) ? id.toLowerCase() : id;
}
