/** Each trigger needs a distinct Mention node and pluginKey so plugins do not collide. */

import Mention from "@tiptap/extension-mention";
import { PluginKey } from "@tiptap/pm/state";
import { ReactRenderer } from "@tiptap/react";
import type { SuggestionKeyDownProps, SuggestionProps } from "@tiptap/suggestion";
import { searchFiles } from "~/lib/files";
import { searchKnowledge } from "~/lib/knowledge-api";
import { MENTION_KINDS, type MentionKind } from "./mention-config";
import { MentionList, type MentionListRef } from "./mention-list";
import { filterItems, type MentionItem } from "./serialize";
import type { GetItems } from "./use-mention-data";

// `~knowledge` is search-powered: each keystroke runs a server fuzzy search (the KB is unbounded, so a
// static client-filtered list won't do). An empty query shows nothing; a failed search degrades to an
// empty menu. The latest keystroke's result wins (Tiptap re-renders on each resolved `items`).
async function searchKnowledgeItems(query: string): Promise<MentionItem[]> {
  if (query.trim() === "") return [];
  try {
    const { results } = await searchKnowledge(query, 8);
    // De-dupe by page — search returns one hit per matching chunk, so a page can appear twice.
    const seen = new Set<string>();
    const items: MentionItem[] = [];
    for (const r of results) {
      if (seen.has(r.pageId)) continue;
      seen.add(r.pageId);
      items.push({ id: r.pageId, label: r.title, description: r.content.slice(0, 80) });
    }
    return items;
  } catch {
    return [];
  }
}

async function searchFileItems(query: string): Promise<MentionItem[]> {
  if (query.trim() === "") return [];
  try {
    const files = await searchFiles(query, 8);
    return files.map((file) => ({
      id: file.id,
      label: file.filename,
      description: file.mediaType,
      mediaType: file.mediaType,
      sizeBytes: file.sizeBytes,
    }));
  } catch {
    return [];
  }
}

/** One suggestion plugin key per trigger — also consumed by the composer to detect an open menu. */
export const MENTION_PLUGIN_KEYS = MENTION_KINDS.map((c) => new PluginKey(c.nodeName));

// Fresh closure per active suggestion session: mounts the dropdown, repositions it above the caret on
// every update, and forwards keystrokes to the list (Escape falls through so the plugin closes it).
// `kind` is merged into the list props so agent rows can render their glyph avatar.
function suggestionRender(kind: MentionKind) {
  let renderer: ReactRenderer<MentionListRef> | null = null;

  const reposition = (clientRect?: (() => DOMRect | null) | null) => {
    const el = renderer?.element as HTMLElement | undefined;
    if (!el) return;
    const rect = clientRect?.();
    if (!rect) {
      el.style.display = "none";
      return;
    }
    el.style.display = "";
    el.style.position = "fixed";
    el.style.left = `${rect.left}px`;
    el.style.bottom = `${window.innerHeight - rect.top + 6}px`;
    el.style.zIndex = "50";
  };

  return {
    onStart: (props: SuggestionProps) => {
      renderer = new ReactRenderer(MentionList, {
        props: { ...props, kind },
        editor: props.editor,
      });
      document.body.appendChild(renderer.element);
      reposition(props.clientRect);
    },
    onUpdate: (props: SuggestionProps) => {
      renderer?.updateProps({ ...props, kind });
      reposition(props.clientRect);
    },
    onKeyDown: (props: SuggestionKeyDownProps) => {
      if (props.event.key === "Escape") return false;
      return renderer?.ref?.onKeyDown(props) ?? false;
    },
    onExit: () => {
      // Unmount the React tree first, then detach the host node from the document.
      renderer?.destroy();
      renderer?.element.remove();
      renderer = null;
    },
  };
}

/** `getItems` reads live data, so once-created extensions reflect post-mount loads. */
export function buildMentionExtensions(getItems: GetItems) {
  return MENTION_KINDS.map((cfg, i) =>
    Mention.extend({
      name: cfg.nodeName,
      addAttributes() {
        return {
          ...this.parent?.(),
          mediaType: { default: null },
          sizeBytes: { default: null },
        };
      },
    }).configure({
      HTMLAttributes: { class: `tf-mention tf-mention-${cfg.kind}` },
      suggestion: {
        char: cfg.char,
        pluginKey: MENTION_PLUGIN_KEYS[i],
        items:
          cfg.kind === "knowledge"
            ? ({ query }: { query: string }) => searchKnowledgeItems(query)
            : cfg.kind === "file"
              ? ({ query }: { query: string }) => searchFileItems(query)
              : ({ query }: { query: string }) => filterItems(query, getItems(cfg.kind)),
        render: () => suggestionRender(cfg.kind),
      },
    })
  );
}
