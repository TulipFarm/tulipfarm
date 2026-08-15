// Pure synthesis of the OKF reserved index.md listing from pre-fetched space data.
// The DB query that gathers `IndexEntry[]` lives in the service; this module is pure
// path-splitting + markdown rendering so it is fully unit-testable without a database.

/** A page used to render an index listing. */
export interface IndexEntry {
  /** Full space path of the page, e.g. "tables/orders". */
  path: string;
  title: string;
  description: string | null;
}

/**
 * Split a flat list of page paths into the direct child pages and immediate subdirectories
 * of `dirPath` ("" = space root). Pure path logic.
 */
export function directChildren(
  dirPath: string,
  entries: IndexEntry[]
): { pages: IndexEntry[]; subdirs: string[] } {
  const prefix = dirPath === "" ? "" : `${dirPath.replace(/\/+$/, "")}/`;
  const pages: IndexEntry[] = [];
  const subdirs = new Set<string>();
  for (const e of entries) {
    if (prefix !== "" && !e.path.startsWith(prefix)) continue;
    const rest = e.path.slice(prefix.length);
    if (rest === "" || rest.startsWith("/")) continue;
    const slash = rest.indexOf("/");
    if (slash === -1) pages.push(e);
    else subdirs.add(rest.slice(0, slash));
  }
  pages.sort((a, b) => a.path.localeCompare(b.path));
  return { pages, subdirs: [...subdirs].sort() };
}

/** Render an OKF `index.md` listing for `dirPath` from its direct children. */
export function renderIndex(dirPath: string, entries: IndexEntry[]): string {
  const { pages, subdirs } = directChildren(dirPath, entries);
  const lines: string[] = [];
  if (subdirs.length > 0) {
    lines.push("# Subdirectories", "");
    for (const d of subdirs) lines.push(`* [${d}](${d}/)`);
    lines.push("");
  }
  if (pages.length > 0) {
    lines.push("# Pages", "");
    for (const c of pages) {
      const base = c.path.split("/").at(-1) ?? c.path;
      const desc = c.description ? ` - ${c.description}` : "";
      lines.push(`* [${c.title}](${base}.md)${desc}`);
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}
