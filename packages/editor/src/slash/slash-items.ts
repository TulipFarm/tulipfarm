import type { Editor, Range } from "@tiptap/core";
import { CALLOUT_KINDS } from "../extensions/callout";

/*
 * Slash (`/`) command catalog. Each item runs a TipTap command after deleting the typed `/query`
 * range. The catalog + `filterSlashItems` are pure (unit-tested); the menu UI (slash-menu.ts) just
 * renders the filtered list and calls `run`.
 */

export interface SlashItem {
  id: string;
  title: string;
  /** Lowercase search terms (besides the title) used by the fuzzy-ish filter. */
  keywords: string[];
  group: "Basic" | "Lists" | "Blocks";
  run: (editor: Editor, range: Range) => void;
}

export const SLASH_ITEMS: SlashItem[] = [
  {
    id: "h1",
    title: "Heading 1",
    keywords: ["title", "h1", "#"],
    group: "Basic",
    run: (e, r) => e.chain().focus().deleteRange(r).setNode("heading", { level: 1 }).run(),
  },
  {
    id: "h2",
    title: "Heading 2",
    keywords: ["subtitle", "h2", "##"],
    group: "Basic",
    run: (e, r) => e.chain().focus().deleteRange(r).setNode("heading", { level: 2 }).run(),
  },
  {
    id: "h3",
    title: "Heading 3",
    keywords: ["h3", "###"],
    group: "Basic",
    run: (e, r) => e.chain().focus().deleteRange(r).setNode("heading", { level: 3 }).run(),
  },
  {
    id: "paragraph",
    title: "Text",
    keywords: ["paragraph", "body", "p"],
    group: "Basic",
    run: (e, r) => e.chain().focus().deleteRange(r).setParagraph().run(),
  },
  {
    id: "bullet",
    title: "Bulleted list",
    keywords: ["unordered", "ul", "list", "-"],
    group: "Lists",
    run: (e, r) => e.chain().focus().deleteRange(r).toggleBulletList().run(),
  },
  {
    id: "ordered",
    title: "Numbered list",
    keywords: ["ordered", "ol", "list", "1."],
    group: "Lists",
    run: (e, r) => e.chain().focus().deleteRange(r).toggleOrderedList().run(),
  },
  {
    id: "task",
    title: "To-do list",
    keywords: ["task", "todo", "checkbox", "check"],
    group: "Lists",
    run: (e, r) => e.chain().focus().deleteRange(r).toggleTaskList().run(),
  },
  {
    id: "quote",
    title: "Quote",
    keywords: ["blockquote", "citation", ">"],
    group: "Blocks",
    run: (e, r) => e.chain().focus().deleteRange(r).toggleBlockquote().run(),
  },
  {
    id: "code",
    title: "Code block",
    keywords: ["code", "snippet", "pre", "```"],
    group: "Blocks",
    run: (e, r) => e.chain().focus().deleteRange(r).toggleCodeBlock().run(),
  },
  {
    id: "table",
    title: "Table",
    keywords: ["table", "grid"],
    group: "Blocks",
    run: (e, r) =>
      e.chain().focus().deleteRange(r).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
  },
  {
    id: "divider",
    title: "Divider",
    keywords: ["hr", "rule", "separator", "---"],
    group: "Blocks",
    run: (e, r) => e.chain().focus().deleteRange(r).setHorizontalRule().run(),
  },
  ...CALLOUT_KINDS.map(
    (kind): SlashItem => ({
      id: `callout-${kind.toLowerCase()}`,
      title: `Callout: ${kind.charAt(0) + kind.slice(1).toLowerCase()}`,
      keywords: ["callout", "alert", "admonition", kind.toLowerCase()],
      group: "Blocks",
      run: (e, r) =>
        e
          .chain()
          .focus()
          .deleteRange(r)
          .insertContent({ type: "callout", attrs: { kind }, content: [{ type: "paragraph" }] })
          .run(),
    })
  ),
];

/** Filter the catalog by a query: matches the title or any keyword (case-insensitive substring). */
export function filterSlashItems(query: string, items: SlashItem[] = SLASH_ITEMS): SlashItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter(
    (it) =>
      it.title.toLowerCase().includes(q) || it.keywords.some((k) => k.toLowerCase().includes(q))
  );
}
