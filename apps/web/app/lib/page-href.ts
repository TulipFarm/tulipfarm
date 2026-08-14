/* Rendered page hrefs use stable UUID routes; OKF sources stay path-based. */
import type { SpacePageRef } from "./knowledge-api";

const BASE = "/knowledge/pages";

// Strip a stored/authored path to its bare form (no leading/trailing slash, no `.md`).
function normPath(p: string): string {
  return p.replace(/^\/+|\/+$/g, "").replace(/\.md$/i, "");
}

// Cosmetic slug from a path's last segment (or a title): lowercase, url-safe, hyphenated.
export function pageSlug(source: string | null | undefined): string {
  if (!source) return "";
  const bare = normPath(source);
  const last = bare.includes("/") ? bare.slice(bare.lastIndexOf("/") + 1) : bare;
  return last
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Canonical page URL: `/knowledge/pages/<id>/<slug>` (slug omitted when it derives empty).
export function pageHref(id: string, slugFrom?: string | null): string {
  const slug = pageSlug(slugFrom);
  return slug ? `${BASE}/${encodeURIComponent(id)}/${slug}` : `${BASE}/${encodeURIComponent(id)}`;
}

export interface PageResolver {
  /** Same-space reference → its page (e.g. an authored `[x](orders.md)` inside space S). */
  bySpaceIdPath(spaceId: string, path: string): SpacePageRef | null;
  /** Cross-space reference → its page (a `tf:page/<SpaceName>/<path>` link). */
  bySpaceNamePath(spaceName: string, path: string): SpacePageRef | null;
  /** A page id → its page ref (sidebar active-highlight, slug derivation). */
  byId(pageId: string): SpacePageRef | null;
}

// Build the resolver from one `listAllPages()` payload (every page across every space).
export function buildPageResolver(pages: SpacePageRef[]): PageResolver {
  const key = (a: string, p: string) => `${a} ${normPath(p)}`;
  const byIdPath = new Map<string, SpacePageRef>();
  const byNamePath = new Map<string, SpacePageRef>();
  const byId = new Map<string, SpacePageRef>();
  for (const p of pages) {
    byIdPath.set(key(p.spaceId, p.path), p);
    byNamePath.set(key(p.spaceName, p.path), p);
    byId.set(p.pageId, p);
  }
  return {
    bySpaceIdPath: (s, path) => byIdPath.get(key(s, path)) ?? null,
    bySpaceNamePath: (n, path) => byNamePath.get(key(n, path)) ?? null,
    byId: (id) => byId.get(id) ?? null,
  };
}
