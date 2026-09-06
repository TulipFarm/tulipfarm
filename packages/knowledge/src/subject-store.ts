/**
 * Projects stored authored Pages into the subjects the ACL gate decides on, resolving each Page
 * against the entries it inherits from its ancestor Pages and its Space, and expands a request's
 * Principals into the Roles and Teams the actor holds. Grants naming a group stay the group and are
 * never flattened into its members. The entry row shape it reads is owned by `./acl-repo`.
 */

import { ROUTINE_SERVICE_PRINCIPAL_ID } from "@tulipfarm/constants";
import type { Queryable } from "@tulipfarm/storage";
import { ENTRY_COLS, rowToEntry } from "./acl-repo";
import { canonicalKnowledgeId } from "./ids";
import type { KnowledgePrincipalRef, KnowledgeSourceStatus } from "./source";
import {
  BLANKET_READ_PRINCIPAL,
  type KnowledgeAclEntry,
  type KnowledgeOwnershipPort,
  type KnowledgeSubject,
  type KnowledgeSubjectStore,
  type PrincipalResolverPort,
  pageSubject,
  spaceSubject,
} from "./subject";

/**
 * `handbook/pay/bands` → `["handbook", "handbook/pay"]`, outermost first.
 *
 * Emitted without a leading slash so it matches `knowledge_pages.path`, which `normalizePagePath`
 * stores unslashed. A leading slash here silently resolved no ancestor at all, so nesting inherited
 * nothing.
 */
function ancestorPaths(path: string | null): readonly string[] {
  if (path === null) return [];
  const segments = path.split("/").filter((s) => s.length > 0);
  return segments.slice(0, -1).map((_, i) => segments.slice(0, i + 1).join("/"));
}

function principalKey(principal: KnowledgeAclEntry["principal"]): string {
  return `${principal.kind}\u0000${principal.id}`;
}

const BLANKET_KEY = principalKey(BLANKET_READ_PRINCIPAL);

/** Which level of the chain an entry set came from. */
export interface AclLevelRef {
  readonly kind: "space" | "page";
  readonly id: string;
}

/** Where a Page's readership comes from, with the provenance a read decision throws away. */
/** Where one Page's readership comes from, without naming anyone. */
export interface PageVisibilityScope {
  readonly scope: "business" | "own" | "inherited";
  readonly inheritedFrom: AclLevelRef | null;
}

export interface PageVisibilitySource {
  /** Principals the Page itself names, excluding the default Business-wide grant. */
  readonly own: readonly KnowledgePrincipalRef[];
  /** The deepest ancestor that narrows this Page, or null when none does. */
  readonly inheritedFrom: AclLevelRef | null;
  /** Who the ancestors alone permit. Null when no ancestor restricts. */
  readonly ancestorReaders: readonly KnowledgePrincipalRef[] | null;
  /** Who may actually read it, after the whole chain resolves. */
  readonly readers: readonly KnowledgePrincipalRef[];
}

function grantsOf(entries: readonly KnowledgeAclEntry[]): readonly KnowledgePrincipalRef[] {
  return entries
    .filter((e) => e.effect === "grant")
    .map((e) => ({ kind: e.principal.kind, id: e.principal.id }));
}

/**
 * A level carrying only the blanket "everyone in this Business" grant is not a restriction: every
 * authored Page gets that grant by default, so treating it as one would report every Page as
 * restricted by its Space.
 */
function isRestriction(entries: readonly KnowledgeAclEntry[]): boolean {
  const grants = entries.filter((e) => e.effect === "grant");
  if (grants.length === 0) return false;
  return !grants.some((entry) => principalKey(entry.principal) === BLANKET_KEY);
}

/** `space_id` + path → Page id, so an ancestor chain resolves without a query per level. */
function pathIndex(rows: readonly Record<string, unknown>[]): ReadonlyMap<string, string> {
  const byPath = new Map<string, string>();
  for (const row of rows) {
    const path = row.path as string | null;
    if (path === null) continue;
    const key = ancestorKey(row.space_id as string | null, path);
    if (!byPath.has(key)) byPath.set(key, row.id as string);
  }
  return byPath;
}

/**
 * Paths are unique per Space, not per Business (`knowledge_pages_space_path_idx`), so an ancestor
 * is only an ancestor within the same Space. Keying on the path alone lets one Space's `handbook`
 * stand in for another's, which either leaks a restricted subtree or restricts an unrelated one,
 * depending on row order.
 */
function ancestorKey(spaceId: string | null, path: string): string {
  return `${spaceId ?? ""}\u0000${normalizeAclPath(path)}`;
}

/** Stored paths are unslashed, but a caller may hand us either shape. Compare one way only. */
function normalizeAclPath(path: string): string {
  return path.replace(/^\/+|\/+$/g, "");
}

/**
 * Collapses a subject's inheritance chain into the entries the gate should decide on.
 *
 * `chain` runs outermost first — Space, then each ancestor Page, then the subject itself. Grants
 * are **intersected** rather than unioned: each level that grants anything narrows the permitted
 * set, and a level that grants nothing inherits its parent's unchanged. A union would let a
 * descendant re-open what an ancestor restricted, because the gate allows on any matching grant.
 *
 * Denies accumulate from every level and are never narrowed away — a deny anywhere still wins.
 *
 * A level whose only grant is the blanket "everyone in this Business" Principal is treated as *no
 * restriction at this level*: it neither narrows an ancestor's list nor re-opens one. Every authored
 * Page carries that grant by default, so without this a restricted Space would intersect to nothing
 * and lock out even the people it was restricted to. It is still the effective grant when no
 * ancestor has restricted anything, which is what keeps an unrestricted corpus Business-wide.
 */
function effectiveEntries(
  chain: readonly (readonly KnowledgeAclEntry[])[]
): readonly KnowledgeAclEntry[] {
  const denies: KnowledgeAclEntry[] = [];
  // `undefined` means no level has restricted yet, which is not the same as "nobody is permitted".
  let permitted: Map<string, KnowledgeAclEntry> | undefined;
  let blanket: KnowledgeAclEntry | undefined;

  for (const level of chain) {
    const grants = new Map<string, KnowledgeAclEntry>();
    for (const entry of level) {
      if (entry.effect === "deny") denies.push(entry);
      else grants.set(principalKey(entry.principal), entry);
    }
    if (grants.size === 0) continue;
    // Checked before the baseline is taken, not after: an *open* ancestor reaching this first would
    // otherwise become the list every descendant is intersected against, and `{everyone}` ∩
    // `{alice}` is empty — locking out the very Principal a restriction names.
    if (grants.has(BLANKET_KEY)) {
      blanket ??= grants.get(BLANKET_KEY);
      continue;
    }
    if (permitted === undefined) {
      permitted = grants;
      continue;
    }
    const narrowed = new Map<string, KnowledgeAclEntry>();
    for (const [key, entry] of grants) {
      if (permitted.has(key)) narrowed.set(key, entry);
    }
    permitted = narrowed;
  }

  // No level restricted anything, so the blanket grant every authored Page carries is the answer —
  // which is what keeps an untouched corpus readable Business-wide.
  if (permitted === undefined && blanket !== undefined) return [blanket, ...denies];
  return [...(permitted?.values() ?? []), ...denies];
}

/**
 * Reads authored Pages as gate subjects, resolving each Page against the entries it inherits from
 * its ancestor Pages and its Space.
 *
 * The join is deliberately one query per listing rather than one per Page: authorization has to
 * stay linear in the corpus.
 */
export class PgKnowledgeSubjectStore implements KnowledgeSubjectStore {
  constructor(
    private readonly q: Queryable,
    private readonly now: () => Date = () => new Date(),
    private readonly ownership?: KnowledgeOwnershipPort
  ) {}

  async listAuthored(businessId: string): Promise<readonly KnowledgeSubject[]> {
    const { rows } = await this.q.query(
      `SELECT p.id, p.space_id, p.business_id, p.version, p.acl_revision, p.active, p.path
         FROM knowledge_pages p
        WHERE p.business_id = $1`,
      [businessId]
    );
    if (rows.length === 0) return [];
    const entries = await this.entriesFor(
      businessId,
      rows.map((row) => row.id as string),
      rows.map((row) => row.space_id as string | null)
    );
    const byPath = pathIndex(rows);
    return rows.map((row) => this.toSubject(row, entries, byPath));
  }

  async getAuthored(businessId: string, subjectId: string): Promise<KnowledgeSubject | undefined> {
    const [subject] = await this.getManyAuthored(businessId, [subjectId]);
    return subject;
  }

  async getManySpaces(
    businessId: string,
    spaceIds: readonly string[]
  ): Promise<readonly KnowledgeSubject[]> {
    if (spaceIds.length === 0) return [];
    const { rows } = await this.q.query(
      `SELECT id, business_id, acl_revision
         FROM knowledge_spaces
        WHERE business_id = $1 AND id::text = ANY($2::text[])`,
      [businessId, [...spaceIds]]
    );
    const entries = await this.entriesFor(
      businessId,
      [],
      rows.map((row) => row.id as string)
    );
    const byId = new Map(rows.map((row) => [row.id as string, row]));
    return spaceIds.flatMap((id) => {
      const row = byId.get(id);
      return row === undefined
        ? []
        : [
            spaceSubject(
              {
                spaceId: id,
                businessId: row.business_id as string,
                aclRevision: row.acl_revision as string,
              },
              entries.get(`space:${id}`) ?? [
                {
                  subjectKind: "space",
                  subjectId: id,
                  principal: BLANKET_READ_PRINCIPAL,
                  effect: "grant",
                  capability: "read",
                },
              ],
              this.now()
            ),
          ];
    });
  }

  /**
   * Authorizing a listing must not cost a round trip per Page, so the ancestor walk and the entry
   * lookup are each done once for the whole batch. Order follows `subjectIds`; a Page that does not
   * exist is simply absent.
   */
  async getManyAuthored(
    businessId: string,
    subjectIds: readonly string[]
  ): Promise<readonly KnowledgeSubject[]> {
    if (subjectIds.length === 0) return [];
    const { rows } = await this.q.query(
      `SELECT p.id, p.space_id, p.business_id, p.version, p.acl_revision, p.active, p.path
         FROM knowledge_pages p
        WHERE p.business_id = $1 AND p.id::text = ANY($2::text[])`,
      [businessId, [...subjectIds]]
    );
    if (rows.length === 0) return [];
    const ancestors = await this.ancestorsOfMany(
      businessId,
      rows.map((row) => ({
        spaceId: row.space_id as string | null,
        path: row.path as string | null,
      }))
    );
    const entries = await this.entriesFor(
      businessId,
      [...rows, ...ancestors].map((row) => row.id as string),
      rows.map((row) => row.space_id as string | null)
    );
    const byPath = pathIndex([...rows, ...ancestors]);
    const byId = new Map(rows.map((row) => [row.id as string, row]));
    const out: KnowledgeSubject[] = [];
    for (const id of subjectIds) {
      const row = byId.get(id);
      if (row !== undefined) out.push(this.toSubject(row, entries, byPath));
    }
    return out;
  }

  /**
   * The Principals permitted to read a Page **at a hypothetical location**.
   *
   * Deliberately routed through the same `effectiveEntries` resolution a real read uses, so a move
   * preview cannot disagree with what the move actually does.
   */
  async effectiveReadersAt(
    businessId: string,
    at: { readonly pageId: string; readonly spaceId: string | null; readonly path: string | null }
  ): Promise<readonly KnowledgePrincipalRef[]> {
    const ancestors = await this.ancestorsOfMany(businessId, [
      { spaceId: at.spaceId, path: at.path },
    ]);
    const entries = await this.entriesFor(
      businessId,
      [at.pageId, ...ancestors.map((row) => row.id as string)],
      [at.spaceId]
    );
    const byPath = pathIndex(ancestors);

    const chain: KnowledgeAclEntry[][] = [];
    if (at.spaceId !== null) chain.push(entries.get(`space:${at.spaceId}`) ?? []);
    for (const path of ancestorPaths(at.path)) {
      const ancestorId = byPath.get(ancestorKey(at.spaceId, path));
      // A Page is not its own ancestor: moving `notes` to `notes` must not chain it to itself.
      if (ancestorId !== undefined && ancestorId !== at.pageId) {
        chain.push(entries.get(`page:${ancestorId}`) ?? []);
      }
    }
    chain.push(entries.get(`page:${at.pageId}`) ?? []);

    return effectiveEntries(chain)
      .filter((e) => e.effect === "grant")
      .map((e) => ({ kind: e.principal.kind, id: e.principal.id }));
  }

  /**
   * Where a Page's readership actually comes from.
   *
   * `effectiveReadersAt` collapses the ancestor chain into one answer, which is right for a read
   * decision and wrong for an explanation: it cannot say *which* level narrowed the Page. An author
   * shown an ancestor's list as if it were the Page's own will try to remove a restriction they
   * cannot remove from here.
   *
   * @returns null when the Page does not exist, which the caller must answer identically to a Page
   * the caller may not read.
   */
  /**
   * Where each Page's readership comes from, for a whole listing at once.
   *
   * Answers strictly less than {@link visibilityOf} — no reader expansion — because a tree badge
   * needs only the three cases a reader must tell apart, and running the full answer per row would
   * cost one round trip per Page.
   */
  async scopesOf(
    businessId: string,
    pageIds: readonly string[]
  ): Promise<Map<string, PageVisibilityScope>> {
    const out = new Map<string, PageVisibilityScope>();
    if (pageIds.length === 0) return out;

    const { rows } = await this.q.query(
      `SELECT id, space_id, path FROM knowledge_pages
        WHERE business_id = $1 AND id = ANY($2::uuid[])`,
      [businessId, [...pageIds]]
    );
    const pages = rows as Array<{ id: string; space_id: string | null; path: string | null }>;
    if (pages.length === 0) return out;

    const ancestors = await this.ancestorsOfMany(
      businessId,
      pages.map((p) => ({ spaceId: p.space_id, path: p.path }))
    );
    const byPath = pathIndex(ancestors);
    const entries = await this.entriesFor(
      businessId,
      [...pages.map((p) => p.id), ...ancestors.map((r) => r.id as string)],
      pages.map((p) => p.space_id)
    );

    for (const p of pages) {
      if (isRestriction(entries.get(`page:${p.id}`) ?? [])) {
        // Its own restriction is the one an author can change from this Page, so it wins the label
        // even when an ancestor also restricts.
        out.set(p.id, { scope: "own", inheritedFrom: null });
        continue;
      }

      let inheritedFrom: AclLevelRef | null = null;
      if (p.space_id !== null && isRestriction(entries.get(`space:${p.space_id}`) ?? [])) {
        inheritedFrom = { kind: "space", id: p.space_id };
      }
      for (const path of ancestorPaths(p.path)) {
        const id = byPath.get(ancestorKey(p.space_id, path));
        if (id !== undefined && id !== p.id && isRestriction(entries.get(`page:${id}`) ?? [])) {
          inheritedFrom = { kind: "page", id };
        }
      }

      out.set(
        p.id,
        inheritedFrom === null
          ? { scope: "business", inheritedFrom: null }
          : { scope: "inherited", inheritedFrom }
      );
    }
    return out;
  }

  async visibilityOf(businessId: string, pageId: string): Promise<PageVisibilitySource | null> {
    const { rows } = await this.q.query(
      `SELECT id, space_id, path FROM knowledge_pages WHERE business_id = $1 AND id = $2`,
      [businessId, pageId]
    );
    const row = rows[0] as { space_id: string | null; path: string | null } | undefined;
    if (row === undefined) return null;

    const spaceId = row.space_id;
    const path = row.path;
    const ancestors = await this.ancestorsOfMany(businessId, [{ spaceId, path }]);
    const entries = await this.entriesFor(
      businessId,
      [pageId, ...ancestors.map((r) => r.id as string)],
      [spaceId]
    );
    const byPath = pathIndex(ancestors);

    const levels: Array<{ from: AclLevelRef; entries: readonly KnowledgeAclEntry[] }> = [];
    if (spaceId !== null) {
      levels.push({
        from: { kind: "space", id: spaceId },
        entries: entries.get(`space:${spaceId}`) ?? [],
      });
    }
    for (const p of ancestorPaths(path)) {
      const ancestorId = byPath.get(ancestorKey(spaceId, p));
      if (ancestorId !== undefined && ancestorId !== pageId) {
        levels.push({
          from: { kind: "page", id: ancestorId },
          entries: entries.get(`page:${ancestorId}`) ?? [],
        });
      }
    }
    const ownEntries = entries.get(`page:${pageId}`) ?? [];

    // The deepest ancestor that genuinely narrows is the one an author must be told about — a
    // shallower one has already been intersected into it.
    let inheritedFrom: AclLevelRef | null = null;
    for (const level of levels) if (isRestriction(level.entries)) inheritedFrom = level.from;

    const chain = [...levels.map((l) => l.entries), ownEntries];
    return {
      own: grantsOf(ownEntries).filter((g) => principalKey(g) !== BLANKET_KEY),
      inheritedFrom,
      ancestorReaders:
        inheritedFrom === null ? null : grantsOf(effectiveEntries(levels.map((l) => l.entries))),
      readers: grantsOf(effectiveEntries(chain)),
    };
  }

  /**
   * Every proper path prefix of every location in the batch, resolved in one query.
   *
   * Matched on `(space_id, path)`, not path alone: a prefix only names an ancestor inside the same
   * Space. `IS NOT DISTINCT FROM` rather than `=` because `space_id` is nullable and a null-Space
   * Page's ancestors are the other null-Space Pages.
   */
  private async ancestorsOfMany(
    businessId: string,
    locations: readonly { readonly spaceId: string | null; readonly path: string | null }[]
  ): Promise<readonly Record<string, unknown>[]> {
    const wantedSpaces: (string | null)[] = [];
    const wantedPaths: string[] = [];
    const seen = new Set<string>();
    // Both shapes: `normalizePagePath` stores unslashed, but rows written before it — and by other
    // writers — may carry a leading slash. Matching one shape only silently resolves no ancestor.
    for (const { spaceId, path } of locations)
      for (const p of ancestorPaths(path))
        for (const candidate of [p, `/${p}`]) {
          // Deduped on the *raw* candidate: `ancestorKey` normalizes, which would collapse the
          // slashed and unslashed shapes into one and drop the variant the row is actually stored as.
          const key = `${spaceId ?? ""}\u0000${candidate}`;
          if (seen.has(key)) continue;
          seen.add(key);
          wantedSpaces.push(spaceId);
          wantedPaths.push(candidate);
        }
    if (wantedPaths.length === 0) return [];
    const { rows } = await this.q.query(
      `SELECT p.id, p.space_id, p.path FROM knowledge_pages p
         JOIN unnest($2::text[], $3::text[]) AS w(space_id, path)
           ON p.path = w.path AND p.space_id::text IS NOT DISTINCT FROM w.space_id
        WHERE p.business_id = $1`,
      [businessId, wantedSpaces, wantedPaths]
    );
    return rows;
  }

  /** One lookup for every page and space in the listing, keyed `kind:id`. */
  private async entriesFor(
    businessId: string,
    pageIds: readonly string[],
    spaceIds: readonly (string | null)[]
  ): Promise<Map<string, KnowledgeAclEntry[]>> {
    const spaces = [
      ...new Set(spaceIds.filter((id): id is string => id !== null).map(canonicalKnowledgeId)),
    ];
    const { rows } = await this.q.query(
      `SELECT ${ENTRY_COLS} FROM knowledge_acl_entries
        WHERE business_id = $1
          AND ((subject_kind = 'page' AND lower(subject_id) = ANY($2::text[]))
            OR (subject_kind = 'space' AND lower(subject_id) = ANY($3::text[])))`,
      [businessId, pageIds.map(canonicalKnowledgeId), spaces]
    );
    const byKey = new Map<string, KnowledgeAclEntry[]>();
    for (const row of rows) {
      const key = `${row.subject_kind as string}:${canonicalKnowledgeId(row.subject_id as string)}`;
      const bucket = byKey.get(key);
      if (bucket === undefined) byKey.set(key, [rowToEntry(row)]);
      else bucket.push(rowToEntry(row));
    }
    const subjects = [
      ...pageIds.map((id) => ({ kind: "page" as const, id: canonicalKnowledgeId(id) })),
      ...spaces.map((id) => ({ kind: "space" as const, id })),
    ];
    const ownershipEntries = await this.ownership?.entriesFor(businessId, subjects);
    for (const [key, projected] of ownershipEntries ?? []) {
      const bucket = byKey.get(key) ?? [];
      bucket.push(...projected);
      byKey.set(key, bucket);
    }
    return byKey;
  }

  private toSubject(
    row: Record<string, unknown>,
    entries: Map<string, KnowledgeAclEntry[]>,
    byPath: ReadonlyMap<string, string>
  ): KnowledgeSubject {
    const pageId = row.id as string;
    const spaceId = (row.space_id as string | null) ?? null;
    const status: KnowledgeSourceStatus = (row.active as boolean) ? "active" : "revoked";
    const chain: KnowledgeAclEntry[][] = [];
    if (spaceId !== null) chain.push(entries.get(`space:${spaceId}`) ?? []);
    for (const path of ancestorPaths(row.path as string | null)) {
      const ancestorId = byPath.get(ancestorKey(spaceId, path));
      if (ancestorId !== undefined) chain.push(entries.get(`page:${ancestorId}`) ?? []);
    }
    chain.push(entries.get(`page:${pageId}`) ?? []);
    return pageSubject(
      {
        pageId,
        spaceId,
        businessId: row.business_id as string,
        revision: String(row.version as number),
        aclRevision: row.acl_revision as string,
        status,
      },
      effectiveEntries(chain),
      this.now()
    );
  }
}

/**
 * Expands a request's Principals into everything the actor holds: the blanket Role, their Teams,
 * and their Roles — but only when a signed-in human member is behind the call.
 *
 * Membership is read on every request rather than stored, so "everyone" cannot drift out of step
 * with who actually has an account. Exclusion is structural, not a filter: a Routine State acts as
 * `service:routine-executor` and an Agent carries an `agent` Principal, neither of which is a
 * `users` row, so no autonomous caller can acquire the Role however the call is shaped. An Agent
 * acting *for* a person carries that person's Principal and inherits it through the authority
 * intersection that already caps an Agent at its caller.
 *
 * Expiry is honoured on both sides of a Team: a lapsed membership and a lapsed Team each expand to
 * nothing, so access ends when the grant does rather than at the next reindex.
 */
export class PgPrincipalResolver implements PrincipalResolverPort {
  constructor(
    private readonly q: Queryable,
    private readonly blanket: KnowledgePrincipalRef = BLANKET_READ_PRINCIPAL
  ) {}

  async resolve(input: {
    readonly businessId: string;
    readonly principals: readonly KnowledgePrincipalRef[];
  }): Promise<readonly KnowledgePrincipalRef[]> {
    const candidates = input.principals
      .filter((principal) => ["user", "agent", "service"].includes(principal.kind))
      .map((principal) => principal.id);
    const userCandidates = input.principals
      .filter((principal) => principal.kind === "user")
      .map((principal) => principal.id);
    if (candidates.length === 0) return input.principals;

    // A Routine is the Business acting on its own behalf, so it reads what the Business can read.
    // It gains the blanket Role and nothing else: no Team, no Role, so a Page whose blanket grant
    // has been replaced by an allowlist stays closed to it.
    if (userCandidates.includes(ROUTINE_SERVICE_PRINCIPAL_ID)) {
      const withBlanket = new Map<string, KnowledgePrincipalRef>();
      for (const p of input.principals) withBlanket.set(`${p.kind}\u0000${p.id}`, p);
      withBlanket.set(`${this.blanket.kind}\u0000${this.blanket.id}`, this.blanket);
      return [...withBlanket.values()];
    }

    // Compared as text: a non-uuid id such as `service:routine-executor` must simply fail to match
    // rather than raise and take the whole request down with it.
    const members =
      userCandidates.length === 0
        ? []
        : (
            await this.q.query(
              "SELECT id::text AS id FROM users WHERE id::text = ANY($1::text[])",
              [userCandidates]
            )
          ).rows.map((r) => r.id as string);

    const out = new Map<string, KnowledgePrincipalRef>();
    for (const p of input.principals) out.set(`${p.kind}\u0000${p.id}`, p);
    const add = (ref: KnowledgePrincipalRef) => out.set(`${ref.kind}\u0000${ref.id}`, ref);

    if (members.length > 0) {
      add(this.blanket);
      for (const ref of await this.legacyGroupsOf(input.businessId, members)) add(ref);
      for (const ref of await this.rolesOf(input.businessId, members)) add(ref);
    }
    for (const ref of await this.teamsOf(input.businessId, candidates)) add(ref);
    return [...out.values()];
  }

  /** Teams. An expired membership, or membership of an expired Team, expands to nothing. */
  private async teamsOf(
    businessId: string,
    members: readonly string[]
  ): Promise<readonly KnowledgePrincipalRef[]> {
    const { rows } = await this.q.query(
      `WITH RECURSIVE held(team_id, parent_team_id) AS (
         SELECT team.id, team.parent_team_id
           FROM team_memberships membership
           JOIN teams team ON team.id = membership.team_id
           JOIN principals principal
             ON principal.business_id = team.business_id
            AND principal.id = membership.principal_id
          WHERE team.business_id = $1
            AND membership.principal_id = ANY($2::text[])
            AND (membership.expires_at IS NULL OR membership.expires_at > now())
            AND team.status = 'active'
            AND principal.status = 'active'
            AND (principal.expires_at IS NULL OR principal.expires_at > now())
         UNION
         SELECT parent.id, parent.parent_team_id
           FROM teams parent
           JOIN held child ON child.parent_team_id = parent.id
          WHERE parent.business_id = $1 AND parent.status = 'active'
       )
       SELECT DISTINCT team_id::text AS id FROM held`,
      [businessId, members]
    );
    return rows.map((row) => ({ kind: "team", id: row.id as string }));
  }

  private async legacyGroupsOf(
    businessId: string,
    members: readonly string[]
  ): Promise<readonly KnowledgePrincipalRef[]> {
    const { rows } = await this.q.query(
      `SELECT m.group_id FROM principal_group_members m
         JOIN principal_groups g ON g.business_id = m.business_id AND g.id = m.group_id
        WHERE m.business_id = $1
          AND m.principal_id = ANY($2::text[])
          AND (m.expires_at IS NULL OR m.expires_at > now())
          AND (g.expires_at IS NULL OR g.expires_at > now())`,
      [businessId, members]
    );
    return rows.map((r) => ({ kind: "group", id: r.group_id as string }));
  }

  private async rolesOf(
    businessId: string,
    members: readonly string[]
  ): Promise<readonly KnowledgePrincipalRef[]> {
    const { rows } = await this.q.query(
      `SELECT role_id FROM role_assignments
        WHERE business_id = $1
          AND principal_id = ANY($2::text[])
          AND (expires_at IS NULL OR expires_at > now())`,
      [businessId, members]
    );
    return rows.map((r) => ({ kind: "role", id: r.role_id as string }));
  }
}
