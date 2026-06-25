import type { AnyExtension } from "@tiptap/core";
import { TableKit } from "@tiptap/extension-table";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import StarterKit from "@tiptap/starter-kit";
import { Callout } from "./callout";

export interface BuildExtensionsOptions {
  /** Phase-2 mention extensions (@page / @agent / #resource), injected by the host app. */
  mentionExtensions?: AnyExtension[];
}

/**
 * The canonical CONTENT schema for knowledge pages — the single source of truth shared by the React
 * `<PageEditor>` and the headless `MarkdownManager` (markdown/markdown.ts). Every block here is
 * markdown-expressible so the body round-trips to markdown (modulo normalization). It deliberately
 * EXCLUDES the `@tiptap/markdown` engine extension and editor-only chrome (Placeholder, slash menu),
 * which the React editor composes on top — keeping this list usable by the DOM-free markdown bridge.
 *
 * Block set: headings 1–3, bold/italic/strike, inline code, links, bullet/ordered/task lists, tables,
 * code blocks, blockquotes, dividers. Callouts (GitHub-alert `> [!NOTE]`) are appended by the callout
 * extension in a later wave.
 */
export function buildContentExtensions(opts: BuildExtensionsOptions = {}): AnyExtension[] {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
      // StarterKit bundles Link; keep it non-auto-opening + class-tagged to match the chat composer.
      // NB: `tf:` mention hrefs are sanitized to "" in the editor DOM (TipTap's URI guard) but the mark
      // attr + markdown serialization preserve them, and editor links are non-interactive — so it's
      // cosmetic. We deliberately do NOT add `protocols: ["tf"]`: that path calls linkifyjs's global
      // `registerCustomProtocol`/`reset`, which a second live editor's teardown would clobber.
      link: { openOnClick: false, autolink: true, HTMLAttributes: { class: "tf-editor-link" } },
    }),
    TaskList,
    TaskItem.configure({ nested: true }),
    TableKit.configure({ table: { resizable: false } }),
    Callout,
    ...(opts.mentionExtensions ?? []),
  ];
}
