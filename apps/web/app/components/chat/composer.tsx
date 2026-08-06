import Placeholder from "@tiptap/extension-placeholder";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import StarterKit from "@tiptap/starter-kit";
import {
  ArrowUp,
  AtSign,
  Bold,
  BookOpen,
  Code,
  Database,
  Italic,
  Link as LinkIcon,
  Slash,
  Sparkles,
  Square,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { AgentGlyph } from "~/components/agent-glyph";
import { Tooltip } from "~/components/ui/tooltip";
import type { Autonomy } from "~/lib/agents";
import type { ModelTier } from "~/lib/chat/types";
import type { Suggestion } from "~/lib/onboarding";
import { buildMentionExtensions, MENTION_PLUGIN_KEYS } from "./editor/mentions";
import { firstAgentMentionId, type PMNode, serializeDoc } from "./editor/serialize";
import { useMentionData } from "./editor/use-mention-data";
import { effectiveTier, ModelSelector } from "./model-selector";

/** What a composed turn carries to the parent: the model tier plus the resolved mention tags. */
export type ComposerSendOptions = {
  model: ModelTier;
  agentId?: string;
  skills: string[];
  resources: string[];
  knowledgePages: string[];
};

export type ComposerAgent = {
  name: string;
  label?: string;
  domain?: string;
  autonomy?: Autonomy;
};

/**
 * Message composer: a Tiptap rich-text editor over a control row (model override + send). The editor
 * supports markdown formatting (bold/italic/code/link via shortcuts + a selection BubbleMenu) and four
 * mention triggers — `@agent` (routes the turn), `/skill` and `#resource` (eagerly injected into the
 * agent's context for the turn). On send the document is serialized (`serializeDoc`) to markdown text
 * plus the structured tags. Enter sends; Shift+Enter is a newline; Enter is deferred to the suggestion
 * menu while one is open. There is deliberately NO attachment affordance (no blob storage in V1).
 */
export function Composer({
  onSend,
  onStop,
  busy,
  defaultModel = "standard",
  activeAgentTier,
  tierById,
  activeAgent,
  suggestions = [],
}: {
  onSend: (text: string, opts: ComposerSendOptions) => void;
  // Halt the in-flight reply (shown as a Stop button while `busy`); also restores the last sent
  // prompt into the editor to fix and resend.
  onStop?: () => void;
  busy?: boolean;
  defaultModel?: ModelTier;
  // The active conversation agent's tier — reflected in the MODEL selector when no `@agent` is typed.
  activeAgentTier?: ModelTier;
  // agentId → its pickable tier; used to reflect an `@`-mentioned agent's tier as it's typed.
  tierById?: (id: string) => ModelTier | undefined;
  // Quiet context indicator above the prompt surface. The editor's `@agent` mention still owns
  // per-Turn routing; this label describes the Agent currently attached to the Chat.
  activeAgent?: ComposerAgent;
  // Adaptive starter prompts. Selecting one drafts it in the editor so the person can review or
  // refine it before sending; suggestions never run automatically.
  suggestions?: Suggestion[];
}) {
  const [model, setModel] = useState<ModelTier>(defaultModel);
  const getItems = useMentionData();
  const mentionExtensions = useMemo(() => buildMentionExtensions(getItems), [getItems]);
  // editorProps is frozen at creation, so route Enter through a ref that always holds the latest
  // closure (current model/busy/onSend) — avoids the classic Tiptap stale-closure on send.
  const submitRef = useRef<() => void>(() => {});
  // The last sent document (Tiptap JSON), stashed before clearing so Stop can restore it verbatim —
  // mention chips included (getJSON ↔ setContent round-trips exactly).
  const lastSentDocRef = useRef<PMNode | null>(null);

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
          "tf-editor max-h-[220px] min-h-[4.25rem] overflow-y-auto px-4 py-3 text-sm leading-relaxed text-foreground outline-none",
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
      // The first `@agent` mention in the box, recomputed on each edit — drives the MODEL tier below.
      mentionedAgentId: editor ? firstAgentMentionId(editor.getJSON() as PMNode) : undefined,
    }),
  });
  const isEmpty = state?.isEmpty ?? true;

  // The MODEL selector reflects the tier of the agent that will handle the next turn: the `@`-mentioned
  // agent in the box, else the active conversation agent, else the default. Keyed on the derived tier
  // string so the effect only fires on an actual tier change — a manual dropdown pick therefore sticks
  // until the relevant agent changes (D5).
  const tier = effectiveTier({
    mentionedAgentId: state?.mentionedAgentId,
    tierById: tierById ?? (() => undefined),
    activeAgentTier,
    fallback: defaultModel,
  });
  useEffect(() => {
    setModel(tier);
  }, [tier]);

  submitRef.current = () => {
    if (!editor || busy) return;
    const doc = editor.getJSON() as PMNode;
    const { text, agentId, skills, resources, knowledge } = serializeDoc(doc);
    if (!text) return;
    onSend(text, { model, agentId, skills, resources, knowledgePages: knowledge });
    lastSentDocRef.current = doc;
    editor.commands.clearContent();
  };

  function handleStop() {
    onStop?.();
    // Restore the last sent prompt so it can be fixed and resent — but never clobber a draft the user
    // began typing while the reply streamed.
    if (editor?.isEmpty && lastSentDocRef.current) {
      editor.commands.setContent(lastSentDocRef.current);
      editor.commands.selectTextblockEnd();
      editor.view.focus();
    }
  }

  function setLink() {
    if (!editor) return;
    const prev = editor.getAttributes("link").href as string | undefined;
    const url = window.prompt("Link URL", prev ?? "https://");
    if (url === null) return;
    const chain = editor.chain().focus().extendMarkRange("link");
    if (url === "") chain.unsetLink().run();
    else chain.setLink({ href: url }).run();
  }

  function insertContextTrigger(trigger: "@" | "/" | "#" | "~") {
    if (!editor) return;
    editor.commands.insertContent(trigger);
    editor.view.focus();
  }

  function draftSuggestion(prompt: string) {
    if (!editor || busy) return;
    editor.commands.setContent(prompt);
    editor.commands.selectTextblockEnd();
    editor.view.focus();
  }

  return (
    <div className="shrink-0 bg-background">
      <div className="mx-auto w-full max-w-6xl px-4 pb-3 pt-2 sm:px-6">
        <div className="mb-1.5 flex min-h-8 items-center gap-2 px-1 text-xs text-muted-foreground">
          <ModelSelector value={model} onChange={setModel} disabled={busy} />
          {activeAgent ? (
            <>
              <span aria-hidden className="h-4 w-px bg-border" />
              <div className="flex min-w-0 items-center gap-1.5">
                <AgentGlyph
                  name={activeAgent.name}
                  domain={activeAgent.domain}
                  autonomy={activeAgent.autonomy}
                  size="xs"
                  active
                  state={busy ? "thinking" : "idle"}
                  decorative
                />
                <span className="truncate font-medium text-foreground">
                  {activeAgent.label ?? activeAgent.name}
                </span>
              </div>
            </>
          ) : null}
        </div>
        <div className="overflow-hidden rounded-lg border border-input bg-card transition-[border-color,box-shadow] focus-within:border-primary focus-within:ring-[3px] focus-within:ring-ring/15">
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
          <div className="flex items-center gap-1 px-2 pb-2 pt-0.5">
            <ContextTrigger
              label="Mention Agent"
              shortcut="@"
              onClick={() => insertContextTrigger("@")}
            >
              <AtSign aria-hidden className="size-4" />
            </ContextTrigger>
            <ContextTrigger
              label="Add Skill"
              shortcut="/"
              onClick={() => insertContextTrigger("/")}
            >
              <Slash aria-hidden className="size-4" />
            </ContextTrigger>
            <ContextTrigger
              label="Add Resource type"
              shortcut="#"
              onClick={() => insertContextTrigger("#")}
            >
              <Database aria-hidden className="size-4" />
            </ContextTrigger>
            <ContextTrigger
              label="Pin Knowledge page"
              shortcut="~"
              onClick={() => insertContextTrigger("~")}
            >
              <BookOpen aria-hidden className="size-4" />
            </ContextTrigger>
            {busy ? (
              <span className="ml-auto inline-flex">
                <Tooltip content="Stop response">
                  <button
                    type="button"
                    onClick={handleStop}
                    aria-label="Stop response"
                    className="inline-flex size-11 items-center justify-center rounded-full border border-input bg-foreground text-background transition-colors hover:bg-foreground/85 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/30 sm:size-9"
                  >
                    <Square aria-hidden className="size-3.5 fill-current" />
                  </button>
                </Tooltip>
              </span>
            ) : (
              <span className="ml-auto inline-flex">
                <Tooltip content="Send prompt">
                  <button
                    type="button"
                    aria-label="Send prompt"
                    onClick={() => submitRef.current()}
                    disabled={isEmpty}
                    className="inline-flex size-11 items-center justify-center rounded-full bg-primary text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/30 disabled:opacity-35 sm:size-9"
                  >
                    <ArrowUp aria-hidden className="size-4" strokeWidth={2.25} />
                  </button>
                </Tooltip>
              </span>
            )}
          </div>
        </div>
        {suggestions.length > 0 ? (
          <fieldset className="mt-2 flex w-full min-w-0 gap-2 overflow-x-auto px-0.5 pb-1">
            <legend className="sr-only">Suggested prompts</legend>
            {suggestions.map((suggestion) => (
              <button
                key={suggestion.id}
                type="button"
                disabled={busy}
                onClick={() => draftSuggestion(suggestion.prompt)}
                className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-input bg-background px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:border-primary/60 hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/25 disabled:opacity-50"
              >
                <Sparkles aria-hidden className="size-3.5 text-primary" />
                {suggestion.label}
              </button>
            ))}
          </fieldset>
        ) : null}
        <p className="sr-only">Enter to send · Shift+Enter for a new line</p>
      </div>
    </div>
  );
}

function ContextTrigger({
  label,
  shortcut,
  onClick,
  children,
}: {
  label: string;
  shortcut: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip content={`${label} (${shortcut})`}>
      <button
        type="button"
        aria-label={`${label} (${shortcut})`}
        onClick={onClick}
        className="inline-flex size-11 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/25 sm:size-9"
      >
        {children}
      </button>
    </Tooltip>
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
