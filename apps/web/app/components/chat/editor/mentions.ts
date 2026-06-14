/**
 * Tiptap glue for the three composer mention triggers. Each `@`/`/`/`#` is a separately-named
 * `Mention` node (so the serializer can tell them apart) with its own suggestion `pluginKey` (so the
 * three suggestion plugins don't collide). The dropdown is rendered with `ReactRenderer` into
 * `document.body` and positioned above the caret — mirroring the hand-rolled portal in
 * `model-selector.tsx`, no `tippy`/floating-ui dependency.
 *
 * v3 Mention builds the node-insertion `command` + `allow` per trigger char internally and spreads our
 * overrides last, so supplying `{ char, pluginKey, items, render }` keeps insertion working.
 */

import Mention from "@tiptap/extension-mention";
import { PluginKey } from "@tiptap/pm/state";
import { ReactRenderer } from "@tiptap/react";
import type { SuggestionKeyDownProps, SuggestionProps } from "@tiptap/suggestion";
import { MENTION_KINDS } from "./mention-config";
import { MentionList, type MentionListRef } from "./mention-list";
import { filterItems } from "./serialize";
import type { GetItems } from "./use-mention-data";

/** One suggestion plugin key per trigger — also consumed by the composer to detect an open menu. */
export const MENTION_PLUGIN_KEYS = MENTION_KINDS.map((c) => new PluginKey(c.nodeName));

// Fresh closure per active suggestion session: mounts the dropdown, repositions it above the caret on
// every update, and forwards keystrokes to the list (Escape falls through so the plugin closes it).
function suggestionRender() {
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
      renderer = new ReactRenderer(MentionList, { props, editor: props.editor });
      document.body.appendChild(renderer.element);
      reposition(props.clientRect);
    },
    onUpdate: (props: SuggestionProps) => {
      renderer?.updateProps(props);
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

/**
 * Build the three configured Mention extensions for the editor. `getItems` reads the live menu data
 * (from `useMentionData`) on every keystroke, so the extensions can be created once and still reflect
 * lists that load after mount.
 */
export function buildMentionExtensions(getItems: GetItems) {
  return MENTION_KINDS.map((cfg, i) =>
    Mention.extend({ name: cfg.nodeName }).configure({
      HTMLAttributes: { class: `tf-mention tf-mention-${cfg.kind}` },
      suggestion: {
        char: cfg.char,
        pluginKey: MENTION_PLUGIN_KEYS[i],
        items: ({ query }: { query: string }) => filterItems(query, getItems(cfg.kind)),
        render: suggestionRender,
      },
    })
  );
}
