/**
 * An OIM package that has been reviewed but not written.
 *
 * Authoring is two calls: the first validates the manifest and reports what it would be allowed to
 * do, the second writes it. Holding the exact bytes is the whole point — if the second call
 * re-derived them from arguments the model sent again, an Agent could have one package reviewed
 * and a different one written under the approval that review earned.
 */
export interface IntegrationDraft {
  /** `metadata.id` — the directory the package lands in. */
  readonly slug: string;
  /** The normalized `oim.yml` bytes the review was computed over. */
  readonly manifestYaml: string;
  readonly setupGuide?: string;
}

/**
 * Long enough to read a capability review and decide, short enough that an approval cannot be
 * banked and spent against a Soul that has moved on.
 */
const DRAFT_TTL_MS = 10 * 60 * 1000;

/** A ceiling so a Turn that reviews repeatedly without writing cannot grow this without bound. */
const MAX_DRAFTS = 32;

const drafts = new Map<string, { draft: IntegrationDraft; expires: number }>();

function prune(now: number): void {
  for (const [digest, entry] of drafts) if (entry.expires <= now) drafts.delete(digest);
  while (drafts.size >= MAX_DRAFTS) {
    const oldest = drafts.keys().next().value;
    if (oldest === undefined) break;
    drafts.delete(oldest);
  }
}

/**
 * Parks a reviewed draft under its package digest.
 *
 * The digest is the token deliberately: it is what the review reported, so a caller who never read
 * the review cannot name it, and naming it is therefore the approval.
 */
export function putIntegrationDraft(digest: string, draft: IntegrationDraft): void {
  const now = Date.now();
  prune(now);
  drafts.set(digest, { draft, expires: now + DRAFT_TTL_MS });
}

/** Spends a digest, or reports nothing if it was never reviewed, expired, or was already written. */
export function takeIntegrationDraft(digest: string): IntegrationDraft | undefined {
  const now = Date.now();
  prune(now);
  const entry = drafts.get(digest);
  if (entry === undefined) return undefined;
  drafts.delete(digest);
  return entry.expires > now ? entry.draft : undefined;
}

/** Test seam: drafts are process-wide, so a suite must be able to start from empty. */
export function resetIntegrationDrafts(): void {
  drafts.clear();
}
