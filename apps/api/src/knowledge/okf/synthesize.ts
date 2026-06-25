// Pure synthesis of the OKF reserved index.md listing from pre-fetched bundle data.
// The DB query that gathers `IndexEntry[]` lives in the service; this module is pure
// path-splitting + markdown rendering so it is fully unit-testable without a database.

/** A concept used to render an index listing. */
export interface IndexEntry {
  /** Full bundle path of the concept, e.g. "tables/orders". */
  path: string;
  title: string;
  description: string | null;
}

/**
 * Split a flat list of concept paths into the direct child concepts and immediate subdirectories
 * of `dirPath` ("" = bundle root). Pure path logic.
 */
export function directChildren(
  dirPath: string,
  entries: IndexEntry[]
): { concepts: IndexEntry[]; subdirs: string[] } {
  const prefix = dirPath === "" ? "" : `${dirPath.replace(/\/+$/, "")}/`;
  const concepts: IndexEntry[] = [];
  const subdirs = new Set<string>();
  for (const e of entries) {
    if (prefix !== "" && !e.path.startsWith(prefix)) continue;
    const rest = e.path.slice(prefix.length);
    if (rest === "" || rest.startsWith("/")) continue;
    const slash = rest.indexOf("/");
    if (slash === -1) concepts.push(e);
    else subdirs.add(rest.slice(0, slash));
  }
  concepts.sort((a, b) => a.path.localeCompare(b.path));
  return { concepts, subdirs: [...subdirs].sort() };
}

/** Render an OKF `index.md` listing for `dirPath` from its direct children. */
export function renderIndex(dirPath: string, entries: IndexEntry[]): string {
  const { concepts, subdirs } = directChildren(dirPath, entries);
  const lines: string[] = [];
  if (subdirs.length > 0) {
    lines.push("# Subdirectories", "");
    for (const d of subdirs) lines.push(`* [${d}](${d}/)`);
    lines.push("");
  }
  if (concepts.length > 0) {
    lines.push("# Concepts", "");
    for (const c of concepts) {
      const base = c.path.split("/").at(-1) ?? c.path;
      const desc = c.description ? ` - ${c.description}` : "";
      lines.push(`* [${c.title}](${base}.md)${desc}`);
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}
