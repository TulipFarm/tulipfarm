import { type Editor, Extension } from "@tiptap/core";
import { PluginKey } from "@tiptap/pm/state";
import Suggestion, { type SuggestionOptions } from "@tiptap/suggestion";
import { filterSlashItems, type SlashItem } from "./slash-items";

/*
 * `/` slash-command extension. Uses @tiptap/suggestion to detect `/query`, and renders a small
 * self-contained popup (vanilla DOM — no React/icon deps, so the package stays light). Block commands
 * come from the pure `slash-items` catalog. Keyboard: ↑/↓ move, Enter picks, Esc closes. The active
 * popup is also torn down on editor destroy (suggestion's `onExit` does NOT fire when the editor
 * unmounts mid-session — without this the popup div leaks into document.body).
 */

interface SlashRenderProps {
  items: SlashItem[];
  command: (item: SlashItem) => void;
  clientRect?: (() => DOMRect | null) | null;
}

interface SlashPopup {
  mount(props: SlashRenderProps): void;
  update(props: SlashRenderProps): void;
  onKeyDown(event: KeyboardEvent): boolean;
  destroy(): void;
}

function createPopup(): SlashPopup {
  let el: HTMLDivElement | null = null;
  let items: SlashItem[] = [];
  let selected = 0;
  let onPick: (item: SlashItem) => void = () => {};

  function destroy() {
    el?.remove();
    el = null;
  }

  function paint() {
    if (!el) return;
    el.replaceChildren();
    if (items.length === 0) {
      const empty = document.createElement("div");
      empty.className = "tf-slash-empty";
      empty.textContent = "No blocks";
      el.appendChild(empty);
      return;
    }
    items.forEach((it, i) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = `tf-slash-item${i === selected ? " is-active" : ""}`;
      row.dataset.group = it.group;
      row.textContent = it.title;
      row.addEventListener("mousedown", (e) => {
        e.preventDefault();
        onPick(it);
      });
      row.addEventListener("mousemove", () => {
        if (selected !== i) {
          selected = i;
          paint();
        }
      });
      el?.appendChild(row);
    });
  }

  function place(rect: DOMRect | null | undefined) {
    if (!el || !rect) return;
    el.style.position = "absolute";
    el.style.left = `${rect.left + window.scrollX}px`;
    el.style.top = `${rect.bottom + window.scrollY + 6}px`;
  }

  return {
    mount(props) {
      el = document.createElement("div");
      el.className = "tf-slash-menu";
      el.setAttribute("role", "listbox");
      document.body.appendChild(el);
      this.update(props);
    },
    update(props) {
      items = props.items;
      onPick = props.command;
      if (selected >= items.length) selected = 0;
      paint();
      place(props.clientRect?.());
    },
    onKeyDown(event) {
      if (!el) return false;
      if (event.key === "Escape") {
        destroy(); // suggestion has no built-in Escape→close; tear the popup down ourselves
        return true;
      }
      if (items.length === 0) return false;
      if (event.key === "ArrowDown") {
        selected = (selected + 1) % items.length;
        paint();
        return true;
      }
      if (event.key === "ArrowUp") {
        selected = (selected - 1 + items.length) % items.length;
        paint();
        return true;
      }
      if (event.key === "Enter") {
        onPick(items[selected]);
        return true;
      }
      return false;
    },
    destroy,
  };
}

export const SlashCommands = Extension.create({
  name: "slashCommands",
  addProseMirrorPlugins() {
    let active: SlashPopup | null = null;
    const options: Omit<SuggestionOptions<SlashItem>, "editor"> = {
      // Explicit per-extension key — without it @tiptap/suggestion falls back to a shared module
      // singleton, so two mounted editors would collide on the same ProseMirror state slot.
      pluginKey: new PluginKey("tfSlashCommands"),
      char: "/",
      allowSpaces: false,
      startOfLine: false,
      items: ({ query }) => filterSlashItems(query).slice(0, 10),
      command: ({ editor, range, props }) => props.run(editor as Editor, range),
      render: () => {
        const popup = createPopup();
        active = popup;
        return {
          onStart: (props) => popup.mount(props as unknown as SlashRenderProps),
          onUpdate: (props) => popup.update(props as unknown as SlashRenderProps),
          onKeyDown: (props) => popup.onKeyDown(props.event),
          onExit: () => {
            popup.destroy();
            if (active === popup) active = null;
          },
        };
      },
    };
    // Tear down a still-open popup if the editor is destroyed mid-session (onExit won't fire then).
    this.editor.on("destroy", () => active?.destroy());
    return [Suggestion({ editor: this.editor, ...options })];
  },
});
