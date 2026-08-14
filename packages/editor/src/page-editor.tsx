import type { AnyExtension } from "@tiptap/core";
import Placeholder from "@tiptap/extension-placeholder";
import { Markdown } from "@tiptap/markdown";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import { type ReactNode, useEffect, useRef } from "react";
import { buildContentExtensions } from "./extensions/build-extensions";
import { SlashCommands } from "./slash/slash-menu";

/* Controlled editor: markdown is the boundary; ProseMirror JSON stays internal. */

export interface PageEditorProps {
  /** Markdown body (the single source of truth). */
  value: string;
  onChange: (markdown: string) => void;
  placeholder?: string;
  editable?: boolean;
  className?: string;
  /** `@`/`#` suggestion extensions from `buildMentionExtensions` (host-injected; optional). */
  mentionExtensions?: AnyExtension[];
}

export function PageEditor({
  value,
  onChange,
  placeholder,
  editable = true,
  className,
  mentionExtensions,
}: PageEditorProps) {
  // True while a `value` change originated from the editor's own `onUpdate` — used to skip the
  // re-seed effect so live typing never triggers a setContent (which would reset the cursor).
  const fromEditor = useRef(false);

  const editor = useEditor({
    immediatelyRender: false,
    editable,
    extensions: [
      ...buildContentExtensions({ mentionExtensions }),
      Markdown,
      Placeholder.configure({ placeholder: placeholder ?? 'Write, or press "/" for blocks…' }),
      SlashCommands,
    ],
    content: value,
    contentType: "markdown",
    editorProps: {
      attributes: {
        class: `tf-editor tf-page-editor ${className ?? ""}`.trim(),
        "aria-label": "Page body",
      },
    },
    onUpdate: ({ editor }) => {
      fromEditor.current = true;
      onChange(editor.getMarkdown());
    },
  });

  // Re-seed only when `value` changed EXTERNALLY (switching pages / raw-tab round-trip). A value
  // change the editor itself produced is acknowledged and skipped, so typing never re-seeds.
  useEffect(() => {
    if (!editor) return;
    if (fromEditor.current) {
      fromEditor.current = false;
      return;
    }
    if (value !== editor.getMarkdown()) {
      editor.commands.setContent(value, { contentType: "markdown" });
    }
  }, [editor, value]);

  // Apply `editable` changes in place rather than recreating the editor (which would drop content).
  useEffect(() => {
    editor?.setEditable(editable);
  }, [editor, editable]);

  const marks = useEditorState({
    editor,
    selector: ({ editor }) => ({
      bold: editor?.isActive("bold") ?? false,
      italic: editor?.isActive("italic") ?? false,
      strike: editor?.isActive("strike") ?? false,
      code: editor?.isActive("code") ?? false,
      link: editor?.isActive("link") ?? false,
    }),
  });

  function setLink() {
    if (!editor) return;
    const prev = editor.getAttributes("link").href as string | undefined;
    const url = window.prompt("Link URL", prev ?? "https://");
    if (url === null) return;
    const chain = editor.chain().focus().extendMarkRange("link");
    if (url === "") chain.unsetLink().run();
    else chain.setLink({ href: url }).run();
  }

  return (
    <div className="tf-page-editor-shell">
      {editor ? (
        <BubbleMenu
          editor={editor}
          className="tf-bubble-menu flex items-center gap-0.5 rounded-sm border border-border bg-card p-0.5 shadow-md"
        >
          <Fmt
            label="Bold"
            active={marks?.bold}
            onClick={() => editor.chain().focus().toggleBold().run()}
          >
            B
          </Fmt>
          <Fmt
            label="Italic"
            active={marks?.italic}
            onClick={() => editor.chain().focus().toggleItalic().run()}
          >
            <span className="italic">I</span>
          </Fmt>
          <Fmt
            label="Strikethrough"
            active={marks?.strike}
            onClick={() => editor.chain().focus().toggleStrike().run()}
          >
            <span className="line-through">S</span>
          </Fmt>
          <Fmt
            label="Code"
            active={marks?.code}
            onClick={() => editor.chain().focus().toggleCode().run()}
          >
            <span className="font-mono">{"<>"}</span>
          </Fmt>
          <Fmt label="Link" active={marks?.link} onClick={setLink}>
            ↗
          </Fmt>
        </BubbleMenu>
      ) : null}
      <EditorContent editor={editor} />
    </div>
  );
}

function Fmt({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      className={`cursor-pointer rounded-sm px-2 py-1 text-sm font-semibold transition-colors hover:bg-secondary ${
        active ? "text-primary" : "text-muted-foreground"
      }`}
    >
      {children}
    </button>
  );
}
