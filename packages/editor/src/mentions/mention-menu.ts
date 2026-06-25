import { type Editor, Extension } from "@tiptap/core";
import { PluginKey } from "@tiptap/pm/state";
import Suggestion, { type SuggestionOptions } from "@tiptap/suggestion";
import { filterMentionSections, filterTagSuggestions, type MentionDataSource } from "./host-data";
import {
  createMenuPopup,
  type MenuEntry,
  type MenuPopup,
  type MenuRange,
  type MenuRenderProps,
} from "./mention-popup";

/*
 * The unified `@` mention menu (Pages / Agents / Resources) and the `#` tag menu. Both reuse the
 * `@tiptap/suggestion` machinery (same as the slash menu) and a shared grouped popup. Crucially,
 * neither leaves a custom ProseMirror node: `@` inserts a standard markdown LINK (so the canonical
 * body stays pure markdown and round-trips), and `#` inserts plain `#tag` text. This sidesteps the
 * `@tiptap/markdown` custom-tokenizer pitfall entirely.
 */

/** Insert `[label](href)` as a Link mark, then a trailing unmarked space so typing continues plain. */
function insertLink(label: string, href: string) {
  return (editor: Editor, range: MenuRange) => {
    editor
      .chain()
      .focus()
      .deleteRange(range)
      .insertContent([
        { type: "text", text: label, marks: [{ type: "link", attrs: { href } }] },
        { type: "text", text: " " },
      ])
      .run();
  };
}

/** Insert plain `#tag ` text (tags are not links — they sync to frontmatter on save). */
function insertTag(tag: string) {
  return (editor: Editor, range: MenuRange) => {
    editor.chain().focus().deleteRange(range).insertContent(`#${tag} `).run();
  };
}

function mentionEntries(src: MentionDataSource, query: string): MenuEntry[] {
  const entries: MenuEntry[] = [];
  for (const section of filterMentionSections(src, query)) {
    for (const it of section.items) {
      entries.push({
        section: section.title,
        label: it.label,
        hint: it.hint,
        apply: insertLink(it.label, it.href),
      });
    }
  }
  return entries;
}

function tagEntries(src: MentionDataSource, query: string): MenuEntry[] {
  const { tags, create } = filterTagSuggestions(src.getTags?.() ?? [], query);
  const entries: MenuEntry[] = tags.map((t) => ({
    section: "Tags",
    label: `#${t}`,
    apply: insertTag(t),
  }));
  if (create)
    entries.push({ section: "Tags", label: `Create #${create}`, apply: insertTag(create) });
  return entries;
}

interface MenuExtensionOptions {
  name: string;
  char: string;
  pluginKey: string;
  emptyLabel: string;
  getItems: (query: string) => MenuEntry[];
}

function makeMenuExtension(opts: MenuExtensionOptions): Extension {
  return Extension.create({
    name: opts.name,
    addProseMirrorPlugins() {
      let active: MenuPopup | null = null;
      const suggestion: Omit<SuggestionOptions<MenuEntry>, "editor"> = {
        char: opts.char,
        pluginKey: new PluginKey(opts.pluginKey),
        allowSpaces: false,
        startOfLine: false,
        items: ({ query }) => opts.getItems(query),
        command: ({ editor, range, props }) => props.apply(editor as Editor, range),
        render: () => {
          const popup = createMenuPopup(opts.emptyLabel);
          active = popup;
          return {
            onStart: (p) => popup.mount(p as unknown as MenuRenderProps),
            onUpdate: (p) => popup.update(p as unknown as MenuRenderProps),
            onKeyDown: (p) => popup.onKeyDown(p.event),
            onExit: () => {
              popup.destroy();
              if (active === popup) active = null;
            },
          };
        },
      };
      // Tear down a still-open popup if the editor unmounts mid-session (onExit won't fire then).
      this.editor.on("destroy", () => active?.destroy());
      return [Suggestion({ editor: this.editor, ...suggestion })];
    },
  });
}

/**
 * Build the `@` (pages/agents/resources) + `#` (tags) suggestion extensions, wired to a host data
 * source. Pass the result to `<PageEditor mentionExtensions={…}>`.
 */
export function buildMentionExtensions(src: MentionDataSource): Extension[] {
  return [
    makeMenuExtension({
      name: "tfMentionAt",
      char: "@",
      pluginKey: "tfMentionAt",
      emptyLabel: "No matches",
      getItems: (q) => mentionEntries(src, q),
    }),
    makeMenuExtension({
      name: "tfMentionHash",
      char: "#",
      pluginKey: "tfMentionHash",
      emptyLabel: "Type a tag…",
      getItems: (q) => tagEntries(src, q),
    }),
  ];
}
