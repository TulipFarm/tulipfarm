import { createHash, randomUUID } from "node:crypto";

/**
 * A Skill write that has been audited but not performed.
 *
 * Authoring is two calls: the first audits and parks the result here, the second spends the token
 * and writes. Holding the exact `content` is the whole point — if the second call re-derived the
 * bytes from arguments the model sent again, an Agent could have benign text audited and different
 * text written under the approval the report earned.
 */
export interface SkillDraft {
  readonly kind: "create" | "update";
  readonly name: string;
  readonly version: string;
  readonly body: string;
  readonly frontmatter: Record<string, unknown>;
  /** The exact SKILL.md bytes SkillAudit read. Phase two writes these verbatim. */
  readonly content: string;
  /**
   * For an update, a digest of the body the edit was computed against. A concurrent write moves it,
   * and applying the draft anyway would silently revert whatever landed in between.
   */
  readonly baseDigest?: string;
}

/**
 * Long enough for an operator to read a report and decide, short enough that an approval cannot be
 * banked and spent against a Soul that has moved on.
 */
const DRAFT_TTL_MS = 10 * 60 * 1000;

/** A ceiling so a Turn that audits repeatedly without confirming cannot grow this without bound. */
const MAX_DRAFTS = 32;

const drafts = new Map<string, { draft: SkillDraft; expires: number }>();

function prune(now: number): void {
  for (const [id, entry] of drafts) if (entry.expires <= now) drafts.delete(id);
  while (drafts.size >= MAX_DRAFTS) {
    const oldest = drafts.keys().next().value;
    if (oldest === undefined) break;
    drafts.delete(oldest);
  }
}

/** Digest of the body an edit was based on, so a racing write can be detected before it is lost. */
export function skillBodyDigest(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

/** Parks an audited draft and returns the opaque token that spends it. */
export function putSkillDraft(draft: SkillDraft): string {
  const now = Date.now();
  prune(now);
  const id = randomUUID();
  drafts.set(id, { draft, expires: now + DRAFT_TTL_MS });
  return id;
}

/**
 * Spends a token, or reports nothing if it never existed, already expired, or was already used.
 *
 * One-use is deliberate: a token is the record of a single human decision, so replaying it would
 * turn one approval into standing permission to rewrite a Skill.
 */
export function takeSkillDraft(id: string): SkillDraft | undefined {
  const now = Date.now();
  prune(now);
  const entry = drafts.get(id);
  if (entry === undefined) return undefined;
  drafts.delete(id);
  return entry.expires > now ? entry.draft : undefined;
}

/** Test seam: drafts are process-wide, so a suite must be able to start from empty. */
export function resetSkillDrafts(): void {
  drafts.clear();
}
