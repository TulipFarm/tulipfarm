import Placeholder from "@tiptap/extension-placeholder";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import StarterKit from "@tiptap/starter-kit";
import { Bold, Code, Italic, Link as LinkIcon } from "lucide-react";
import { type ReactNode, useMemo, useRef, useState } from "react";
import type { ModelTier } from "~/lib/chat/types";
import { buildMentionExtensions, MENTION_PLUGIN_KEYS } from "./editor/mentions";
import { type PMNode, serializeDoc } from "./editor/serialize";
import { useMentionData } from "./editor/use-mention-data";
import { ModelSelector } from "./model-selector";

/** What a composed turn carries to the parent: the model tier plus the resolved mention tags. */
export type ComposerSendOptions = {
  model: ModelTier;
  agentId?: string;
  skills: string[];
  resources: string[];
};

/**
 * Message composer: a Tiptap rich-text editor over a control row (model override + send). The editor
 * supports markdown formatting (bold/italic/code/link via shortcuts + a selection BubbleMenu) and three
 * mention triggers — `@agent` (routes the turn), `/skill` and `#resource` (eagerly injected into the
 * agent's context for the turn). On send the document is serialized (`serializeDoc`) to markdown text
 * plus the structured tags. Enter sends; Shift+Enter is a newline; Enter is deferred to the suggestion
 * menu while one is open. There is deliberately NO attachment affordance (no blob storage in V1).
 */
export function Composer({
  onSend,
  busy,
  defaultModel = "standard",
}: {
  onSend: (text: string, opts: ComposerSendOptions) => void;
  busy?: boolean;
  defaultModel?: ModelTier;
}) {
  const [model, setModel] = useState<ModelTier>(defaultModel);
  const getItems = useMentionData();
  const mentionExtensions = useMemo(() => buildMentionExtensions(getItems), [getItems]);
  // editorProps is frozen at creation, so route Enter through a ref that always holds the latest
  // closure (current model/busy/onSend) — avoids the classic Tiptap stale-closure on send.
  const submitRef = useRef<() => void>(() => {});

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({
        heading: false,
        link: { openOnClick: false, autolink: true, HTMLAttributes: { class: "tf-editor-link" } },
      }),
      Placeholder.configure({ placeholder: "Ask anything…" }),
      ...mentionExtensions,
    ],
    editorProps: {
      attributes: {
        class:
          "tf-editor max-h-[180px] min-h-[1.5rem] overflow-y-auto px-3.5 py-3 text-sm leading-relaxed text-foreground outline-none",
        "aria-label": "Message",
      },
      handleKeyDown: (view, event) => {
        if (event.key === "Enter" && !event.shiftKey) {
          // A suggestion menu is open → let it consume Enter to pick the highlighted item.
          if (MENTION_PLUGIN_KEYS.some((k) => k.getState(view.state)?.active)) return false;
          event.preventDefault();
          submitRef.current();
          return true;
        }
        return false;
      },
    },
  });

  const state = useEditorState({
    editor,
    selector: ({ editor }) => ({
      isEmpty: editor?.isEmpty ?? true,
      bold: editor?.isActive("bold") ?? false,
      italic: editor?.isActive("italic") ?? false,
      code: editor?.isActive("code") ?? false,
      link: editor?.isActive("link") ?? false,
    }),
  });
  const isEmpty = state?.isEmpty ?? true;

  submitRef.current = () => {
    if (!editor || busy) return;
    const { text, agentId, skills, resources } = serializeDoc(editor.getJSON() as PMNode);
    if (!text) return;
    onSend(text, { model, agentId, skills, resources });
    editor.commands.clearContent();
  };

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
    <div className="shrink-0 border-t border-border bg-background">
      <div className="mx-auto w-full max-w-3xl px-6 py-3">
        <div className="overflow-hidden rounded-sm border border-input bg-secondary transition-colors focus-within:border-primary">
          {editor ? (
            <BubbleMenu
              editor={editor}
              className="flex items-center gap-0.5 rounded-sm border border-border bg-card p-0.5 shadow-md"
            >
              <FmtButton
                label="bold"
                active={state?.bold}
                onClick={() => editor.chain().focus().toggleBold().run()}
              >
                <Bold className="size-3.5" />
              </FmtButton>
              <FmtButton
                label="italic"
                active={state?.italic}
                onClick={() => editor.chain().focus().toggleItalic().run()}
              >
                <Italic className="size-3.5" />
              </FmtButton>
              <FmtButton
                label="code"
                active={state?.code}
                onClick={() => editor.chain().focus().toggleCode().run()}
              >
                <Code className="size-3.5" />
              </FmtButton>
              <FmtButton label="link" active={state?.link} onClick={setLink}>
                <LinkIcon className="size-3.5" />
              </FmtButton>
            </BubbleMenu>
          ) : null}
          <EditorContent editor={editor} />
          <div className="flex items-center gap-4 border-t border-border/60 px-3 py-2">
            <ModelSelector value={model} onChange={setModel} disabled={busy} />
            <button
              type="button"
              onClick={() => submitRef.current()}
              disabled={isEmpty || busy}
              className="ml-auto inline-flex items-center gap-1.5 rounded-sm bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-40"
            >
              send
              <span aria-hidden className="opacity-70">
                ↵
              </span>
            </button>
          </div>
        </div>
        <p className="mt-1.5 px-1 text-[0.625rem] text-muted-foreground">
          enter to send · shift+enter for newline · <span className="text-primary">/</span>skills ·{" "}
          <span className="text-primary">@</span>agents · <span className="text-primary">#</span>
          resources
        </p>
      </div>
    </div>
  );
}

// One formatting toggle in the selection BubbleMenu. `active` reflects the mark at the cursor (ruby
// when on); the label is the accessible name.
function FmtButton({
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
      className={`rounded-sm p-1.5 transition-colors hover:bg-secondary ${
        active ? "text-primary" : "text-muted-foreground"
      }`}
    >
      {children}
    </button>
  );
}
