/*
 * Pure helpers for the unified knowledge tree. `parseListing` turns the `navigate` endpoint's markdown
 * index into direct child entries; `mergeEntries` collapses a concept (`a.md`) and a sibling directory
 * (`a/`) that share a basename into ONE node — a page that has both its own body AND child pages (the
 * Notion "page with sub-pages"). The link rewriters resolve OKF path references to a concept's stable
 * UUID route via a `ConceptResolver` (built once from `listAllPages()`). No path mutation, no backend conversion.
 */
import { type ConceptResolver, conceptHref } from "./concept-href";

export type ConceptEntry = { kind: "concept"; label: string; path: string };
export type DirEntry = { kind: "dir"; label: string; path: string };
export type Entry = ConceptEntry | DirEntry;

/** A merged tree node: clickable when it has a body, expandable when it has children. */
export interface PageNode {
  /** Full bundle-relative path (the concept route param + the navigate dirPath). */
  path: string;
  label: string;
  hasBody: boolean;
  hasChildren: boolean;
}

// Parse the `navigate` markdown listing into direct child entries for `dirPath`. Only list items of
// the form `* [label](target)` count; `target/` ⇒ subdir, `target.md` ⇒ concept. External links and
// absolute log targets are resolved to full bundle-relative paths.
export function parseListing(dirPath: string, listing: string): Entry[] {
  const base = dirPath ? `${dirPath.replace(/\/+$/, "")}/` : "";
  const entries: Entry[] = [];
  const seen = new Set<string>();
  const re = /^\s*[*-]\s+\[([^\]]*)\]\(([^)]+)\)/;
  for (const line of listing.split("\n")) {
    const m = re.exec(line);
    if (!m) continue;
    const label = m[1].trim();
    const target = m[2].trim();
    if (/^(https?:|mailto:|#)/.test(target)) continue;
    if (target.endsWith("/")) {
      const name = target.replace(/\/+$/, "");
      if (!name || name.includes("/")) continue;
      const path = `${base}${name}`;
      if (seen.has(`d:${path}`)) continue;
      seen.add(`d:${path}`);
      entries.push({ kind: "dir", label: label || name, path });
    } else if (target.endsWith(".md")) {
      const rel = target.replace(/^\.?\//, "").replace(/\.md$/i, "");
      if (!rel) continue;
      const path = target.startsWith("/") ? rel : `${base}${rel}`;
      if (seen.has(`c:${path}`)) continue;
      seen.add(`c:${path}`);
      entries.push({ kind: "concept", label: label || rel, path });
    }
  }
  return entries;
}

/** Collapse concept + dir entries sharing a basename path into one PageNode, preserving order. */
export function mergeEntries(entries: Entry[]): PageNode[] {
  const order: string[] = [];
  const map = new Map<string, PageNode>();
  for (const e of entries) {
    let node = map.get(e.path);
    if (!node) {
      node = { path: e.path, label: e.label, hasBody: false, hasChildren: false };
      map.set(e.path, node);
      order.push(e.path);
    }
    if (e.kind === "concept") {
      node.hasBody = true;
      node.label = e.label; // a concept's own title wins over the directory label
    } else {
      node.hasChildren = true;
      if (!node.hasBody) node.label = e.label;
    }
  }
  return order.map((p) => map.get(p) as PageNode);
}

/** Parse a navigate listing and merge it into tree nodes in one step. */
export function listingToNodes(dirPath: string, listing: string): PageNode[] {
  return mergeEntries(parseListing(dirPath, listing));
}

/**
 * Heuristic: is this `navigate("")` output the SYNTHESIZED contents listing (auto-generated) rather
 * than an authored index.md override? The synthesizer emits an empty doc or one starting with the
 * reserved `# Subdirectories` / `# Concepts` headings. Used so "Edit front page" doesn't freeze the
 * auto-contents as a static override.
 */
export function isSynthesizedIndex(listing: string): boolean {
  const t = listing.trim();
  return t === "" || /^#\s+(Subdirectories|Concepts)\b/.test(t);
}

// Resolve a same-bundle OKF link target (`<dir>/` or `<path>.md`) to a concept's UUID href, or null
// when it isn't a concept link or doesn't resolve. The resolver normalizes the path (slashes + `.md`).
function sameBundleHref(
  target: string,
  bundleId: string,
  resolver: ConceptResolver
): string | null {
  let path: string | null = null;
  if (target.endsWith("/")) path = target.replace(/^\/+/, "").replace(/\/+$/, "");
  else if (target.endsWith(".md"))
    path = target
      .replace(/^\.?\//, "")
      .replace(/^\/+/, "")
      .replace(/\.md$/i, "");
  if (!path) return null;
  const ref = resolver.byBundleIdPath(bundleId, path);
  return ref ? conceptHref(ref.documentId, ref.path) : null;
}

/**
 * Rewrite a bundle's (root-relative) OKF markdown links into stable concept UUID routes so a rendered
 * index page is navigable. `[x](orders.md)` / `[x](tables/)` resolve their same-bundle path to a
 * document id via `resolver`, then emit `/knowledge/concepts/<id>/<slug>`. External (http/mailto/#),
 * already-absolute (`/…`), and unresolved (a pure directory with no concept) links are left untouched.
 */
export function rewriteOkfLinks(
  markdown: string,
  bundleId: string,
  resolver: ConceptResolver
): string {
  return markdown.replace(/\]\(([^)]+)\)/g, (whole, raw: string) => {
    const target = raw.trim();
    if (/^(https?:|mailto:|#|\/)/.test(target)) return whole;
    const href = sameBundleHref(target, bundleId, resolver);
    return href ? `](${href})` : whole;
  });
}

/**
 * Rewrite a CONCEPT BODY's links into stable concept UUID routes for the read view. Handles everything
 * the `@`/`#` editor inserts plus authored OKF links:
 * - `tf:agent/<name>` → `/agents/<name>`, `tf:resource/<type>` → `/resources/<type>`
 * - `tf:page/<Bundle>/<path>` → `/knowledge/concepts/<id>/<slug>` (cross-space, resolved by
 *   `(bundleName, path)`; an unknown/renamed target is left as a `tf:` href so the view renders it muted)
 * - same-bundle `/<path>.md`, `<path>.md`, `<dir>/` → `/knowledge/concepts/<id>/<slug>` (resolved by
 *   `(bundleId, path)`; unresolved is left untouched)
 * `bundleId` is the concept's own bundle (for same-space resolution).
 */
export function rewriteWikiLinks(
  markdown: string,
  bundleId: string,
  resolver: ConceptResolver
): string {
  // Match the whole `[label](target)`; `(?<!!)` before the `[` skips image syntax `![alt](src)` so an
  // image source is never rewritten into a page route. Each branch rebuilds `${label}(<newtarget>)`.
  return markdown.replace(/(?<!!)(\[[^\]]*\])\(([^)]+)\)/g, (whole, label: string, raw: string) => {
    const target = raw.trim();
    if (target.startsWith("tf:agent/")) {
      const name = target.slice("tf:agent/".length);
      return name ? `${label}(/agents/${name})` : whole;
    }
    if (target.startsWith("tf:resource/")) {
      const type = target.slice("tf:resource/".length);
      return type ? `${label}(/resources/${type})` : whole;
    }
    if (target.startsWith("tf:page/")) {
      const rest = target.slice("tf:page/".length);
      const slash = rest.indexOf("/");
      if (slash <= 0) return whole;
      const name = decodeURIComponent(rest.slice(0, slash));
      const path = rest.slice(slash + 1).replace(/\.md$/i, "");
      const ref = path ? resolver.byBundleNamePath(name, path) : null;
      return ref ? `${label}(${conceptHref(ref.documentId, ref.path)})` : whole;
    }
    if (/^(https?:|mailto:|#)/.test(target)) return whole;
    const href = sameBundleHref(target, bundleId, resolver);
    return href ? `${label}(${href})` : whole;
  });
}
