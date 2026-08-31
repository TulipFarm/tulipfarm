import type { AnyExtension } from "@tiptap/core";
import Link from "@tiptap/extension-link";
import { TableKit } from "@tiptap/extension-table";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import StarterKit from "@tiptap/starter-kit";
import { Callout } from "./callout";

export interface BuildExtensionsOptions {
  /** Phase-2 mention extensions (@page / @agent / #resource), injected by the host app. */
  mentionExtensions?: AnyExtension[];
}

// `inclusive` is a Mark config field, not a `LinkOptions` field — `StarterKit`'s `link: {...}`
// forwards to `.configure()`, which cannot reach it. Left at its default (`autolink`, i.e. true),
// typing at a link's edge extends the mark onto whatever comes next instead of ending it.
const NonInclusiveLink = Link.extend({
  inclusive() {
    return false;
  },
});

/** Canonical markdown-only content schema shared by `<PageEditor>` and `MarkdownManager`. */
export function buildContentExtensions(opts: BuildExtensionsOptions = {}): AnyExtension[] {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
      // Keep Link non-auto-opening; do not register `tf:` globally or editors can clobber it.
      link: false,
    }),
    NonInclusiveLink.configure({
      openOnClick: false,
      autolink: true,
      HTMLAttributes: { class: "tf-editor-link" },
    }),
    TaskList,
    TaskItem.configure({ nested: true }),
    TableKit.configure({ table: { resizable: false } }),
    Callout,
    ...(opts.mentionExtensions ?? []),
  ];
}
