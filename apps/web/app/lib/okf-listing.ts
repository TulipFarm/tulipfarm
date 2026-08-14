/* `mergeEntries` makes page+directory basename pairs one Notion-style node. */
import { type PageResolver, pageHref } from "./page-href";

export type PageEntry = { kind: "page"; label: string; path: string };
export type DirEntry = { kind: "dir"; label: string; path: string };
export type Entry = PageEntry | DirEntry;

/** A merged tree node: clickable when it has a body, expandable when it has children. */
export interface PageNode {
  /** Full space-relative path (the page route param + the navigate dirPath). */
  path: string;
  label: string;
  hasBody: boolean;
  hasChildren: boolean;
}

// Parse the `navigate` markdown listing into direct child entries for `dirPath`. Only list items of
// the form `* [label](target)` count; `target/` ⇒ subdir, `target.md` ⇒ page. External links and
// absolute log targets are resolved to full space-relative paths.
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
      entries.push({ kind: "page", label: label || rel, path });
    }
  }
  return entries;
}

/** Collapse page + dir entries sharing a basename path into one PageNode, preserving order. */
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
    if (e.kind === "page") {
      node.hasBody = true;
      node.label = e.label; // a page's own title wins over the directory label
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

/** Detect synthesized root listings so editing does not freeze auto-contents. */
export function isSynthesizedIndex(listing: string): boolean {
  const t = listing.trim();
  return t === "" || /^#\s+(Subdirectories|Pages)\b/.test(t);
}

// Resolve a same-space OKF link target (`<dir>/` or `<path>.md`) to a page's UUID href, or null
// when it isn't a page link or doesn't resolve. The resolver normalizes the path (slashes + `.md`).
function sameSpaceHref(target: string, spaceId: string, resolver: PageResolver): string | null {
  let path: string | null = null;
  if (target.endsWith("/")) path = target.replace(/^\/+/, "").replace(/\/+$/, "");
  else if (target.endsWith(".md"))
    path = target
      .replace(/^\.?\//, "")
      .replace(/^\/+/, "")
      .replace(/\.md$/i, "");
  if (!path) return null;
  const ref = resolver.bySpaceIdPath(spaceId, path);
  return ref ? pageHref(ref.pageId, ref.path) : null;
}

/** Rewrite same-space OKF links to stable page UUID routes; unresolved links stay untouched. */
export function rewriteOkfLinks(markdown: string, spaceId: string, resolver: PageResolver): string {
  return markdown.replace(/\]\(([^)]+)\)/g, (whole, raw: string) => {
    const target = raw.trim();
    if (/^(https?:|mailto:|#|\/)/.test(target)) return whole;
    const href = sameSpaceHref(target, spaceId, resolver);
    return href ? `](${href})` : whole;
  });
}

/** Rewrite page-body `tf:` and OKF links to page UUID routes; unknown targets stay muted. */
export function rewriteWikiLinks(
  markdown: string,
  spaceId: string,
  resolver: PageResolver
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
      const ref = path ? resolver.bySpaceNamePath(name, path) : null;
      return ref ? `${label}(${pageHref(ref.pageId, ref.path)})` : whole;
    }
    if (/^(https?:|mailto:|#)/.test(target)) return whole;
    const href = sameSpaceHref(target, spaceId, resolver);
    return href ? `${label}(${href})` : whole;
  });
}
