import type { Editor } from "@tiptap/core";

/* Shared vanilla-DOM grouped suggestion popup; owner tears it down on editor destroy. */

export interface MenuRange {
  from: number;
  to: number;
}

export interface MenuEntry {
  /** Group header this entry renders under (e.g. "Pages", "Agents", "Tags"). */
  section: string;
  label: string;
  hint?: string;
  /** Performs the insertion when picked. */
  apply: (editor: Editor, range: MenuRange) => void;
}

export interface MenuRenderProps {
  items: MenuEntry[];
  command: (entry: MenuEntry) => void;
  clientRect?: (() => DOMRect | null) | null;
}

export interface MenuPopup {
  mount(props: MenuRenderProps): void;
  update(props: MenuRenderProps): void;
  onKeyDown(event: KeyboardEvent): boolean;
  destroy(): void;
}

export function createMenuPopup(emptyLabel: string): MenuPopup {
  let el: HTMLDivElement | null = null;
  let items: MenuEntry[] = [];
  let selected = 0;
  let onPick: (entry: MenuEntry) => void = () => {};

  function destroy() {
    el?.remove();
    el = null;
  }

  function paint() {
    if (!el) return;
    el.replaceChildren();
    if (items.length === 0) {
      const empty = document.createElement("div");
      empty.className = "tf-mention-empty";
      empty.textContent = emptyLabel;
      el.appendChild(empty);
      return;
    }
    let lastSection: string | null = null;
    items.forEach((it, i) => {
      if (it.section !== lastSection) {
        lastSection = it.section;
        const header = document.createElement("div");
        header.className = "tf-mention-section";
        header.textContent = it.section;
        el?.appendChild(header);
      }
      const row = document.createElement("button");
      row.type = "button";
      row.className = `tf-mention-item${i === selected ? " is-active" : ""}`;
      const label = document.createElement("span");
      label.className = "tf-mention-label";
      label.textContent = it.label;
      row.appendChild(label);
      if (it.hint) {
        const hint = document.createElement("span");
        hint.className = "tf-mention-hint";
        hint.textContent = it.hint;
        row.appendChild(hint);
      }
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
      el.className = "tf-mention-menu";
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
        destroy();
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
