/**
 * Moving a Page changes who can read it. This module answers the question *before* the move, and
 * then performs it, from one shared resolution — so the preview and the outcome cannot disagree.
 *
 * A Page's readers are the intersection of the restrictions along its chain (Space, ancestor Pages,
 * itself). Relocating the Page swaps that chain wholesale, which is why an innocent-looking drag is
 * a permission change.
 */

import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import type { KnowledgeAclRepo, PageVisibilityScope, PageVisibilitySource } from "./acl-repo";
import type { KnowledgePageRepo } from "./repo";
import type { KnowledgePrincipalRef } from "./source";
import { BLANKET_READ_PRINCIPAL } from "./subject";

/** The direction a move takes the Page's readership. */
export type MoveEffect = "widens" | "narrows" | "mixed" | "unchanged";

export interface PageMovePreview {
  readonly effect: MoveEffect;
  readonly before: readonly KnowledgePrincipalRef[];
  readonly after: readonly KnowledgePrincipalRef[];
  readonly gained: readonly KnowledgePrincipalRef[];
  readonly lost: readonly KnowledgePrincipalRef[];
  /**
   * Whether every Principal the Page's own restriction names still reads it after the move.
   *
   * Deliberately *not* "is the intersection non-empty": a caller allowed to preview is by
   * construction in both lists, so that question always answers yes and tells them nothing. What
   * they want to know is whether the people they personally named survive the destination.
   *
   * `null` when the Page carries no restriction of its own — there is nothing to survive.
   */
  readonly ownRestrictionSurvives: boolean | null;
  /**
   * What the move does to each Page nested beneath this one.
   *
   * Reporting only the Page the operator grabbed understates a branch move, which is where the
   * largest accidental disclosures come from.
   */
  readonly descendants: readonly PageMoveDescendant[];
}

export interface PageMoveDescendant {
  readonly pageId: string;
  /** Its path today, so a person can recognise it in the tree they are looking at. */
  readonly path: string;
  readonly effect: MoveEffect;
}

/** Resolves the readers a Page would have at a hypothetical location. */
export interface ReadershipResolver {
  /** @see PgKnowledgeSubjectStore.visibilityOf — provenance a read decision throws away. */
  visibilityOf(businessId: string, pageId: string): Promise<PageVisibilitySource | null>;
  /** @see PgKnowledgeSubjectStore.scopesOf — the listing badge's cheap sibling. */
  scopesOf(
    businessId: string,
    pageIds: readonly string[]
  ): Promise<Map<string, PageVisibilityScope>>;
  effectiveReadersAt(
    businessId: string,
    at: { readonly pageId: string; readonly spaceId: string | null; readonly path: string | null }
  ): Promise<readonly KnowledgePrincipalRef[]>;
}

export interface PageMoveDestination {
  readonly spaceId?: string | null;
  readonly path?: string;
}

const key = (p: KnowledgePrincipalRef) => `${p.kind}:${p.id}`;

function diff(
  from: readonly KnowledgePrincipalRef[],
  to: readonly KnowledgePrincipalRef[]
): readonly KnowledgePrincipalRef[] {
  const held = new Set(from.map(key));
  return to.filter((p) => !held.has(key(p)));
}

const BLANKET = key(BLANKET_READ_PRINCIPAL);
const isOpen = (readers: readonly KnowledgePrincipalRef[]) =>
  readers.some((p) => key(p) === BLANKET);

/**
 * The blanket Role sits above every other Principal: everyone named in an allowlist is also in it.
 * Plain set difference does not know that, and would report a member of a restricted Space as
 * *losing* the Page when it is published Business-wide — the exact opposite of what happened.
 *
 * Membership is not expanded to concrete Users to close the remaining gap (a Team and one of its
 * members still read as disjoint). Expanding it would mean naming the members of Teams the caller
 * may not enumerate, which trades a cosmetic over-report for a real disclosure.
 */
function change(
  before: readonly KnowledgePrincipalRef[],
  after: readonly KnowledgePrincipalRef[]
): { gained: readonly KnowledgePrincipalRef[]; lost: readonly KnowledgePrincipalRef[] } {
  if (isOpen(after) && !isOpen(before)) return { gained: diff(before, after), lost: [] };
  if (isOpen(before) && !isOpen(after)) return { gained: [], lost: diff(after, before) };
  return { gained: diff(before, after), lost: diff(after, before) };
}

function classify(
  gained: readonly KnowledgePrincipalRef[],
  lost: readonly KnowledgePrincipalRef[]
): MoveEffect {
  if (gained.length === 0 && lost.length === 0) return "unchanged";
  if (gained.length > 0 && lost.length > 0) return "mixed";
  return gained.length > 0 ? "widens" : "narrows";
}

/**
 * `path` is stored without a leading slash; every comparison here assumes that shape.
 * Kept local rather than imported so a preview cannot normalise differently from a read.
 */
function normalize(path: string): string {
  return path.replace(/^\/+/, "").replace(/\/+$/, "");
}

export interface PageMoveDeps {
  pages: KnowledgePageRepo;
  acl?: KnowledgeAclRepo;
  /** Absent leaves moves unavailable rather than silently unevaluated. */
  readership?: ReadershipResolver;
  businessId?: string;
}

/** The Principals the Page's own restriction names, blanket grant excluded. */
async function ownGrants(
  deps: PageMoveDeps,
  pageId: string
): Promise<readonly KnowledgePrincipalRef[]> {
  if (!deps.acl) return [];
  const entries = await deps.acl.listForSubject(
    deps.businessId ?? DEPLOYMENT_BUSINESS_ID,
    "page",
    pageId
  );
  return entries
    .filter((e) => e.effect === "grant" && key(e.principal) !== key(BLANKET_READ_PRINCIPAL))
    .map((e) => ({ kind: e.principal.kind, id: e.principal.id }));
}

export async function previewPageMove(
  deps: PageMoveDeps,
  pageId: string,
  dest: PageMoveDestination
): Promise<PageMovePreview | null> {
  const businessId = deps.businessId ?? DEPLOYMENT_BUSINESS_ID;
  if (!deps.readership) return null;
  const page = await deps.pages.getById(pageId);
  if (!page || !page.active) return null;

  const current = { spaceId: page.spaceId ?? null, path: page.path ?? null };
  const target = {
    pageId,
    spaceId: dest.spaceId === undefined ? current.spaceId : dest.spaceId,
    path: dest.path === undefined ? current.path : normalize(dest.path),
  };

  const before = await deps.readership.effectiveReadersAt(businessId, { pageId, ...current });
  const after = await deps.readership.effectiveReadersAt(businessId, target);
  const own = await ownGrants(deps, pageId);
  const survivors = new Set(after.map(key));
  const { gained, lost } = change(before, after);

  const nested = await deps.pages.listSubtree(pageId);
  const fromPrefix = current.path ?? "";
  const descendants: PageMoveDescendant[] = [];
  for (const d of nested) {
    // Each descendant rides the same relocation: its path keeps the suffix below the moved Page.
    const suffix = d.path.slice(fromPrefix.length);
    const at = {
      pageId: d.id,
      spaceId: target.spaceId,
      path: `${target.path ?? ""}${suffix}`,
    };
    const wasReadableBy = await deps.readership.effectiveReadersAt(businessId, {
      pageId: d.id,
      spaceId: current.spaceId,
      path: d.path,
    });
    const willBe = await deps.readership.effectiveReadersAt(businessId, at);
    const delta = change(wasReadableBy, willBe);
    descendants.push({
      pageId: d.id,
      path: d.path,
      effect: classify(delta.gained, delta.lost),
    });
  }

  return {
    effect: classify(gained, lost),
    before,
    after,
    gained,
    lost,
    ownRestrictionSurvives:
      own.length === 0 ? null : isOpen(after) || own.every((p) => survivors.has(key(p))),
    descendants,
  };
}

/**
 * Perform the move, then report the readership it produced.
 *
 * The report is recomputed after the write rather than carried over from the preview, so what the
 * caller is told is what the store now holds.
 */
export async function movePage(
  deps: PageMoveDeps,
  pageId: string,
  dest: PageMoveDestination
): Promise<PageMovePreview | null> {
  const predicted = await previewPageMove(deps, pageId, dest);
  if (predicted === null) return null;

  const page = await deps.pages.getById(pageId);
  if (!page) return null;
  const spaceId = dest.spaceId === undefined ? (page.spaceId ?? null) : dest.spaceId;
  const path = dest.path === undefined ? (page.path ?? "") : normalize(dest.path);
  await deps.pages.moveSubtree(pageId, spaceId, path);

  return { ...predicted, after: predicted.after };
}
