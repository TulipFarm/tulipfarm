/**
 * Restricting an authored Page to an allowlist.
 *
 * Restriction *replaces* the Business-wide grant rather than layering exceptions on top of it. That
 * is what makes a Page's readers readable straight off its grants: the subject list a Page reports
 * is the complete reader list, and there is no state in which a Page reads as open while quietly
 * excluding people.
 *
 * The authoring path never writes a deny. The deny effect stays in the schema and in the gate
 * because synced sources rely on it, but an allowlist that could also carry denials would no longer
 * answer "who can read this?" by inspection.
 */

import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import type { KnowledgeAclRepo } from "./acl-repo";
import type { KnowledgePageRepo } from "./repo";
import type { KnowledgePrincipalRef } from "./source";
import type { KnowledgeSpaceRepo } from "./spaces-repo";
import { BLANKET_READ_PRINCIPAL, type KnowledgeSubjectKind } from "./subject";

/** Whom a Page may be restricted to. Every grouping the product already has, and no new one. */
export type RestrictionSubject = KnowledgePrincipalRef;

export interface PageRestriction {
  /** False means Business-wide: everyone in the Business reads it, and `subjects` is empty. */
  readonly restricted: boolean;
  readonly subjects: readonly RestrictionSubject[];
}

export type RestrictionOutcome = "ok" | "not_found" | "empty_subjects";

interface RestrictionDeps {
  pages: KnowledgePageRepo;
  spaces?: KnowledgeSpaceRepo;
  acl?: KnowledgeAclRepo;
}

const BLANKET_KEY = `${BLANKET_READ_PRINCIPAL.kind}\u0000${BLANKET_READ_PRINCIPAL.id}`;

const key = (p: KnowledgePrincipalRef) => `${p.kind}\u0000${p.id}`;

/**
 * The Page's current readership. Returns null when the Page does not exist, which the caller must
 * answer identically to a Page the caller may not read.
 */
export async function getPageRestriction(
  deps: RestrictionDeps,
  pageId: string
): Promise<PageRestriction | null> {
  if (!deps.acl) return null;
  const page = await deps.pages.getById(pageId);
  if (!page || !page.active) return null;
  return readRestriction(deps, "page", pageId);
}

/**
 * A Space's readership. Restricting a Space restricts everything beneath it, now and later, because
 * the gate resolves a Page against its Space at read time rather than stamping Pages on write.
 */
export async function getSpaceRestriction(
  deps: RestrictionDeps,
  spaceId: string
): Promise<PageRestriction | null> {
  if (!deps.acl || !deps.spaces) return null;
  if (!(await deps.spaces.getById(spaceId))) return null;
  return readRestriction(deps, "space", spaceId);
}

export async function setSpaceRestriction(
  deps: RestrictionDeps,
  spaceId: string,
  subjects: readonly RestrictionSubject[]
): Promise<RestrictionOutcome> {
  if (!deps.acl || !deps.spaces) return "not_found";
  if (!(await deps.spaces.getById(spaceId))) return "not_found";

  const wanted = new Map<string, RestrictionSubject>();
  for (const s of subjects) wanted.set(key(s), s);
  if (wanted.size === 0) return "empty_subjects";

  await replaceGrants(deps, "space", spaceId, [...wanted.values()]);
  await bumpSpacePages(deps, spaceId);
  return "ok";
}

/**
 * Return the Space to Business-wide read. Its entries are dropped rather than replaced with the
 * blanket grant: a Space with no entries is the unrestricted state, and Pages beneath it fall back
 * to their own grants — so a Page restricted on its own stays restricted.
 */
export async function clearSpaceRestriction(
  deps: RestrictionDeps,
  spaceId: string
): Promise<RestrictionOutcome> {
  if (!deps.acl || !deps.spaces) return "not_found";
  if (!(await deps.spaces.getById(spaceId))) return "not_found";

  await replaceGrants(deps, "space", spaceId, []);
  await bumpSpacePages(deps, spaceId);
  return "ok";
}

/** A Space's readership changing changes every Page's, so every Page's snapshot must be refused. */
async function bumpSpacePages(deps: RestrictionDeps, spaceId: string): Promise<void> {
  for (const page of await deps.pages.listBySpace(spaceId)) {
    await deps.pages.bumpAclRevision(page._id);
  }
}

async function readRestriction(
  deps: RestrictionDeps,
  kind: KnowledgeSubjectKind,
  subjectId: string
): Promise<PageRestriction> {
  const acl = deps.acl;
  if (!acl) return { restricted: false, subjects: [] };
  const entries = await acl.listForSubject(DEPLOYMENT_BUSINESS_ID, kind, subjectId);
  const grants = entries.filter((e) => e.effect === "grant" && e.capability === "read");
  if (grants.some((e) => key(e.principal) === BLANKET_KEY)) {
    return { restricted: false, subjects: [] };
  }

  const seen = new Map<string, RestrictionSubject>();
  for (const e of grants)
    seen.set(key(e.principal), { kind: e.principal.kind, id: e.principal.id });
  return { restricted: seen.size > 0, subjects: [...seen.values()] };
}

/**
 * Replace the Page's readership with exactly `subjects`.
 *
 * An empty list is refused rather than written: it would leave a Page no one could read, including
 * whoever was about to fix it.
 */
export async function setPageRestriction(
  deps: RestrictionDeps,
  pageId: string,
  subjects: readonly RestrictionSubject[]
): Promise<RestrictionOutcome> {
  if (!deps.acl) return "not_found";
  const page = await deps.pages.getById(pageId);
  if (!page || !page.active) return "not_found";

  const wanted = new Map<string, RestrictionSubject>();
  for (const s of subjects) wanted.set(key(s), s);
  if (wanted.size === 0) return "empty_subjects";

  await replaceGrants(deps, "page", pageId, [...wanted.values()]);
  await deps.pages.bumpAclRevision(pageId);
  return "ok";
}

/** Return the Page to Business-wide read — the state a newly authored Page starts in. */
export async function clearPageRestriction(
  deps: RestrictionDeps,
  pageId: string
): Promise<RestrictionOutcome> {
  if (!deps.acl) return "not_found";
  const page = await deps.pages.getById(pageId);
  if (!page || !page.active) return "not_found";

  await replaceGrants(deps, "page", pageId, [BLANKET_READ_PRINCIPAL]);
  await deps.pages.bumpAclRevision(pageId);
  return "ok";
}

/**
 * Drop every entry on the Page and write the new allowlist.
 *
 * Removal comes first so restriction cannot accumulate: re-restricting to a smaller list must
 * actually shrink the readership, not add to it.
 */
async function replaceGrants(
  deps: RestrictionDeps,
  subjectKind: KnowledgeSubjectKind,
  subjectId: string,
  subjects: readonly RestrictionSubject[]
): Promise<void> {
  const acl = deps.acl;
  if (!acl) return;
  const existing = await acl.listForSubject(DEPLOYMENT_BUSINESS_ID, subjectKind, subjectId);
  for (const e of existing) {
    await acl.remove(DEPLOYMENT_BUSINESS_ID, subjectKind, subjectId, e.principal);
  }
  for (const principal of subjects) {
    await acl.put({
      businessId: DEPLOYMENT_BUSINESS_ID,
      subjectKind,
      subjectId,
      principal,
      effect: "grant",
      capability: "read",
      origin: "authored",
    });
  }
}
