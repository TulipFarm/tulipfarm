// Host-injected data for the `@` (pages/agents/resources) and `#` (tags) suggestion menus.
// The editor package can't import the web app's API clients, so the host passes stable getters
// (typically reading a ref) and the package handles filtering, sectioning, and insertion.

/** One selectable entry in the `@` menu. `href` is the markdown link target inserted on pick. */
export interface MentionItem {
  /** Display + inserted link text. */
  label: string;
  /** Link href: `path.md` (same-space page), `tf:page/<Bundle>/<path>`, `tf:agent/<name>`, `tf:resource/<type>`. */
  href: string;
  /** Secondary text (e.g. the space name for a cross-space page, or a short description). */
  hint?: string;
}

export interface MentionDataSource {
  /** Pages for the `@` menu — host pre-orders them (current space first). hrefs already encoded. */
  getPages: () => MentionItem[];
  /** Agents for the `@` menu (href `tf:agent/<name>`). */
  getAgents: () => MentionItem[];
  /** Resource types for the `@` menu (href `tf:resource/<type>`). */
  getResources: () => MentionItem[];
  /** Existing tag names for the `#` menu (optional). */
  getTags?: () => string[];
}

export interface MentionSection {
  key: "pages" | "agents" | "resources";
  title: string;
  items: MentionItem[];
}

/** Per-section result cap so the popup stays compact. */
export const SECTION_CAP = 6;

/** Prefix matches before substring matches (label or hint); host order preserved within each tier. */
function rank(items: MentionItem[], q: string): MentionItem[] {
  if (!q) return items;
  const starts: MentionItem[] = [];
  const includes: MentionItem[] = [];
  for (const it of items) {
    const label = it.label.toLowerCase();
    if (label.startsWith(q)) starts.push(it);
    else if (label.includes(q) || (it.hint?.toLowerCase().includes(q) ?? false)) includes.push(it);
  }
  return [...starts, ...includes];
}

/** Filter + rank + cap each section of the `@` menu, dropping empty sections. */
export function filterMentionSections(src: MentionDataSource, query: string): MentionSection[] {
  const q = query.trim().toLowerCase();
  const build = (
    key: MentionSection["key"],
    title: string,
    items: MentionItem[]
  ): MentionSection => ({
    key,
    title,
    items: rank(items, q).slice(0, SECTION_CAP),
  });
  return [
    build("pages", "Pages", src.getPages()),
    build("agents", "Agents", src.getAgents()),
    build("resources", "Resources", src.getResources()),
  ].filter((s) => s.items.length > 0);
}

/** Suggestions for the `#` tag menu: matching existing tags, plus a "create" entry for the query. */
export function filterTagSuggestions(
  tags: string[],
  query: string
): { tags: string[]; create: string | null } {
  const q = query.trim().toLowerCase();
  const matches = (q ? tags.filter((t) => t.toLowerCase().includes(q)) : tags).slice(
    0,
    SECTION_CAP
  );
  // Offer to create the typed tag when it isn't already an exact existing match.
  const exact = tags.some((t) => t.toLowerCase() === q);
  const create = q && !exact ? query.trim() : null;
  return { tags: matches, create };
}
