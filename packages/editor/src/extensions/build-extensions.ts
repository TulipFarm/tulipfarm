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

/** Canonical markdown-only content schema shared by `<PageEditor>` and `MarkdownManager`. */
export function buildContentExtensions(opts: BuildExtensionsOptions = {}): AnyExtension[] {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
      // Keep Link non-auto-opening; do not register `tf:` globally or editors can clobber it.
      link: { openOnClick: false, autolink: true, HTMLAttributes: { class: "tf-editor-link" } },
    }),
    TaskList,
    TaskItem.configure({ nested: true }),
    TableKit.configure({ table: { resizable: false } }),
    Callout,
    ...(opts.mentionExtensions ?? []),
  ];
}
