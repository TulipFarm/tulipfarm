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

/** How many rows a search-powered menu shows before it says there are more. */
const SEARCH_LIMIT = 8;

/**
 * Whether the last answered search for this trigger had more matches than the menu shows.
 *
 * Kept beside the search rather than on the items array because the server returns rows and never a
 * total, so the only way to know the list was cut is to ask for one row more than we show — and the
 * suggestion plugin has nowhere to carry that extra fact.
 */
const truncated: Partial<Record<MentionKind, boolean>> = {};

async function runSearch(
  kind: MentionKind,
  query: string,
  signal: AbortSignal | undefined,
  fetchPage: (query: string, limit: number, signal?: AbortSignal) => Promise<MentionItem[]>
): Promise<MentionItem[]> {
  if (query.trim() === "") {
    truncated[kind] = false;
    return [];
  }
  let page: MentionItem[];
  try {
    page = await fetchPage(query, SEARCH_LIMIT + 1, signal);
  } catch {
    // Includes the abort the plugin raises when a later keystroke supersedes this search; it
    // discards an aborted result, so leaving the flag alone keeps the newest answer's count.
    return [];
  }
  truncated[kind] = page.length > SEARCH_LIMIT;
  return page.slice(0, SEARCH_LIMIT);
}

// `~knowledge` is search-powered: each keystroke runs a server fuzzy search (the KB is unbounded, so a
// static client-filtered list won't do). An empty query shows nothing; a failed search degrades to an
// empty menu.
function searchKnowledgeItems(query: string, signal?: AbortSignal): Promise<MentionItem[]> {
  return runSearch("knowledge", query, signal, async (text, limit) => {
    const { results } = await searchKnowledge(text, limit);
    // De-dupe by page — search returns one hit per matching chunk, so a page can appear twice.
    const seen = new Set<string>();
    const items: MentionItem[] = [];
    for (const r of results) {
      if (seen.has(r.pageId)) continue;
      seen.add(r.pageId);
      items.push({ id: r.pageId, label: r.title, description: r.content.slice(0, 80) });
    }
    return items;
  });
}

function searchFileItems(query: string, signal?: AbortSignal): Promise<MentionItem[]> {
  return runSearch("file", query, signal, async (text, limit, abort) => {
    const files = await searchFiles(text, limit, abort);
    return files.map((file) => ({
      id: file.id,
      label: file.filename,
      description: file.mediaType,
      mediaType: file.mediaType,
      sizeBytes: file.sizeBytes,
    }));
  });
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
        props: { ...props, kind, truncated: truncated[kind] ?? false },
        editor: props.editor,
      });
      document.body.appendChild(renderer.element);
      reposition(props.clientRect);
    },
    onUpdate: (props: SuggestionProps) => {
      renderer?.updateProps({ ...props, kind, truncated: truncated[kind] ?? false });
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
            ? (props: { query: string; signal?: AbortSignal }) =>
                searchKnowledgeItems(props.query, props.signal)
            : cfg.kind === "file"
              ? (props: { query: string; signal?: AbortSignal }) =>
                  searchFileItems(props.query, props.signal)
              : ({ query }: { query: string }) => filterItems(query, getItems(cfg.kind)),
        render: () => suggestionRender(cfg.kind),
      },
    })
  );
}
