import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import StarterKit from "@tiptap/starter-kit";
import { ALLOWED_MEDIA_TYPES, MAX_FILES_PER_MESSAGE } from "@tulipfarm/files/limits";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { AgentGlyph } from "~/components/agent-glyph";
import {
  ArrowUp,
  AtSign,
  Bold,
  BookOpen,
  Code,
  CornerDownRight,
  Database,
  FileText,
  Italic,
  Link as LinkIcon,
  Paperclip,
  Slash,
  Square,
} from "~/components/icons";
import { Tooltip } from "~/components/ui/tooltip";
import type { Autonomy } from "~/lib/agents";
import type { AttachedFile, ChatModelSelector } from "~/lib/chat/types";
import { fetchFile } from "~/lib/files";
import type { Suggestion } from "~/lib/onboarding";
import { AttachmentStrip } from "./attachment-strip";
import { buildMentionExtensions, MENTION_PLUGIN_KEYS } from "./editor/mentions";
import { firstAgentMentionId, type PMNode, serializeDoc } from "./editor/serialize";
import { useMentionData } from "./editor/use-mention-data";
import {
  DEFAULT_CHAT_MODEL_SELECTOR,
  effectiveEffortPreset,
  ModelSelector,
} from "./model-selector";
import { useAttachments } from "./use-attachments";

// `inclusive` is a Mark config field, not a `LinkOptions` field — `StarterKit`'s `link: {...}`
// forwards to `.configure()`, which cannot reach it. Left at its default (`autolink`, i.e. true),
// typing at a link's edge extends the mark onto whatever comes next instead of ending it.
const NonInclusiveLink = Link.extend({
  inclusive() {
    return false;
  },
});

/** What a composed turn carries to the parent: the effort preset plus the resolved mention tags. */
export type ComposerSendOptions = {
  model: ChatModelSelector;
  agentId?: string;
  skills: string[];
  resources: string[];
  knowledgePages: string[];
  files: AttachedFile[];
};

export type ComposerAgent = {
  name: string;
  label?: string;
  domain?: string;
  autonomy?: Autonomy;
};

export type ComposerProps = {
  onSend: (text: string, opts: ComposerSendOptions) => void;
  onStop?: () => void;
  busy?: boolean;
  placement?: "centered" | "docked";
  defaultModel?: ChatModelSelector;
  activeAgentPreset?: ChatModelSelector;
  presetById?: (id: string) => ChatModelSelector | undefined;
  activeAgent?: ComposerAgent;
  suggestions?: Suggestion[];
  /** A prompt to draft into the box once, e.g. seeded by the onboarding Companion. Never sent. */
  initialDraft?: string;
  /** An already-stored File to stage, handed over by the Files library. */
  attachFileId?: string | null;
};

/** Enter sends unless a suggestion menu owns it; Shift+Enter inserts a newline. */
export function ComposerEditor({
  onSend,
  onStop,
  busy,
  placement = "docked",
  defaultModel = DEFAULT_CHAT_MODEL_SELECTOR,
  activeAgentPreset,
  presetById,
  activeAgent,
  suggestions = [],
  initialDraft,
  attachFileId,
}: ComposerProps) {
  const [model, setModel] = useState<ChatModelSelector>(defaultModel);
  const getItems = useMentionData();
  const mentionExtensions = useMemo(() => buildMentionExtensions(getItems), [getItems]);
  // editorProps is frozen at creation, so route Enter through a ref that always holds the latest
  // closure (current preset/busy/onSend) — avoids the classic Tiptap stale-closure on send.
  const submitRef = useRef<() => void>(() => {});
  const pasteRef = useRef<(files: File[]) => void>(() => {});
  // The last sent document (Tiptap JSON), stashed before clearing so Stop can restore it verbatim —
  // mention chips included (getJSON ↔ setContent round-trips exactly).
  const lastSentDocRef = useRef<PMNode | null>(null);

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({
        heading: false,
        link: false,
      }),
      NonInclusiveLink.configure({
        openOnClick: false,
        autolink: true,
        HTMLAttributes: { class: "tf-editor-link" },
      }),
      Placeholder.configure({ placeholder: "Ask anything…" }),
      ...mentionExtensions,
    ],
    editorProps: {
      attributes: {
        class:
          /* Matches the transcript: what you type and what you read back must be the same size. */
          "tf-editor max-h-[220px] min-h-[4.25rem] overflow-y-auto px-3.5 py-2.5 text-base text-foreground outline-none",
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
      // Routed through a ref for the same reason as Enter: `editorProps` is frozen at creation.
      handlePaste: (_view, event) => {
        const pasted = Array.from(event.clipboardData?.files ?? []);
        if (pasted.length === 0) return false;
        event.preventDefault();
        pasteRef.current(pasted);
        return true;
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
      // The first `@agent` mention in the box, recomputed on each edit — drives the preset below.
      mentionedAgentId: editor ? firstAgentMentionId(editor.getJSON() as PMNode) : undefined,
    }),
  });
  const isEmpty = state?.isEmpty ?? true;

  // The preset selector reflects the agent that will handle the next turn: the `@`-mentioned agent
  // in the box, else the active conversation agent, else the default. Keyed on the derived preset
  // string so the effect only fires on an actual preset change — a manual dropdown pick therefore sticks
  // until the relevant agent changes (D5).
  const preset = effectiveEffortPreset({
    mentionedAgentId: state?.mentionedAgentId,
    presetById: presetById ?? (() => undefined),
    activeAgentPreset,
    fallback: defaultModel,
  });
  useEffect(() => {
    setModel(preset);
  }, [preset]);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const { attachments, add, addExisting, remove, clear, readyFiles, uploading } = useAttachments();
  // Only for the border highlight while a drag is over the composer; `onDrop` re-uses the same
  // `add` the file input and paste already call, so there is no second upload path to keep in sync.
  const [dragActive, setDragActive] = useState(false);
  const [fileMentionError, setFileMentionError] = useState<string | null>(null);

  // A File the Files library handed over, staged without re-uploading its bytes. The id arrives as
  // a prop rather than being read from the URL here: the composer is rendered outside a router in
  // the design guide, and a hook that requires one would make it unrenderable there.
  useEffect(() => {
    if (!attachFileId) return;
    const controller = new AbortController();
    fetchFile(attachFileId, controller.signal)
      .then(addExisting)
      .catch(() => {
        // A File that is gone, or was never the caller's, simply does not appear on the composer.
      });
    return () => controller.abort();
  }, [attachFileId, addExisting]);

  pasteRef.current = add;

  submitRef.current = () => {
    if (!editor || busy) return;
    const doc = editor.getJSON() as PMNode;
    const {
      text,
      agentId,
      skills,
      resources,
      knowledge,
      files: mentionedFiles,
    } = serializeDoc(doc);
    // An attachment alone is a message: "what is this?" is often the whole question.
    const files = Array.from(
      new Map(
        [
          ...readyFiles.map((file) => ({
            fileId: file.fileId as string,
            mediaType: file.mediaType,
            name: file.name,
          })),
          ...mentionedFiles,
        ].map((file) => [file.fileId, file])
      ).values()
    );
    if (!text && files.length === 0) return;
    // Sending now would drop whatever is still in flight, silently.
    if (uploading) return;
    if (files.length > MAX_FILES_PER_MESSAGE) {
      setFileMentionError(`You can attach at most ${MAX_FILES_PER_MESSAGE} files to one message.`);
      return;
    }
    setFileMentionError(null);
    onSend(text, { model, agentId, skills, resources, knowledgePages: knowledge, files });
    lastSentDocRef.current = doc;
    clear();
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

  function insertContextTrigger(trigger: "@" | "/" | "#" | "~" | "+") {
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

  // Applies `initialDraft` once the editor exists, and only once per distinct value — a route-level
  // seed (Companion "chat"-action Task), not a live-typing sync back to the box.
  const draftedRef = useRef<string | undefined>(undefined);
  // biome-ignore lint/correctness/useExhaustiveDependencies: draftSuggestion closes over editor/busy already in deps.
  useEffect(() => {
    if (!editor || !initialDraft || draftedRef.current === initialDraft) return;
    draftedRef.current = initialDraft;
    draftSuggestion(initialDraft);
  }, [editor, initialDraft]);

  return (
    <div
      data-composer-placement={placement}
      className={
        placement === "centered" ? "w-full" : "shrink-0 border-t border-border/70 bg-background"
      }
    >
      <div
        className={
          placement === "centered" ? "w-full" : "mx-auto w-full max-w-4xl px-4 pb-4 pt-2 sm:px-6"
        }
      >
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
        {/* biome-ignore lint/a11y/noStaticElementInteractions: a drop target for files, mirroring the paperclip picker; there is no interactive-element equivalent for a drag-and-drop zone. */}
        <div
          className={`overflow-hidden rounded-lg border bg-card transition-[border-color,box-shadow] focus-within:border-primary focus-within:ring-[3px] focus-within:ring-ring/15 ${
            dragActive ? "border-primary ring-[3px] ring-ring/15" : "border-input"
          }`}
          onDragEnter={(event) => {
            event.preventDefault();
            setDragActive(true);
          }}
          onDragLeave={(event) => {
            event.preventDefault();
            if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
            setDragActive(false);
          }}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            setDragActive(false);
            add(Array.from(event.dataTransfer?.files ?? []));
          }}
        >
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
          <AttachmentStrip attachments={attachments} onRemove={remove} />
          {fileMentionError ? (
            <p className="px-3.5 pb-1 text-xs text-destructive" role="alert">
              {fileMentionError}
            </p>
          ) : null}
          <div className="flex items-center gap-1 px-2 pb-2 pt-0.5">
            <input
              accept={ALLOWED_MEDIA_TYPES.join(",")}
              aria-label="Attach files"
              className="hidden"
              multiple
              onChange={(event) => {
                add(Array.from(event.target.files ?? []));
                event.target.value = "";
              }}
              ref={fileInputRef}
              type="file"
            />
            <ContextTrigger label="Attach file" onClick={() => fileInputRef.current?.click()}>
              <Paperclip aria-hidden className="size-4" />
            </ContextTrigger>
            <ContextTrigger label="Add File" shortcut="+" onClick={() => insertContextTrigger("+")}>
              <FileText aria-hidden className="size-4" />
            </ContextTrigger>
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
                    className="inline-flex size-11 items-center justify-center rounded-full border border-input bg-foreground text-background transition hover:bg-foreground/85 active:scale-95 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/30 sm:size-9"
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
                    className="inline-flex size-11 items-center justify-center rounded-full bg-primary text-primary-foreground transition hover:bg-primary/90 active:scale-95 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/30 disabled:opacity-35 sm:size-9"
                  >
                    <ArrowUp aria-hidden className="size-4" strokeWidth={2.25} />
                  </button>
                </Tooltip>
              </span>
            )}
          </div>
        </div>
        {suggestions.length > 0 ? (
          <div className="mt-2">
            <fieldset className="flex flex-wrap gap-2 px-0.5">
              <legend className="sr-only">Suggested prompts</legend>
              {suggestions.map((suggestion) => (
                <button
                  key={suggestion.id}
                  type="button"
                  disabled={busy}
                  onClick={() => draftSuggestion(suggestion.prompt)}
                  className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-input bg-background px-2.5 text-xs font-medium text-muted-foreground transition hover:border-primary/60 hover:bg-accent hover:text-foreground active:translate-y-px focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/25 disabled:opacity-50"
                >
                  <CornerDownRight aria-hidden className="size-3.5 text-primary" />
                  {suggestion.label}
                </button>
              ))}
            </fieldset>
          </div>
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
  /** Absent for a trigger with no keyboard shortcut; "Attach file ()" reads badly aloud. */
  shortcut?: string;
  onClick: () => void;
  children: ReactNode;
}) {
  const described = shortcut === undefined ? label : `${label} (${shortcut})`;
  return (
    <Tooltip content={described}>
      <button
        type="button"
        aria-label={described}
        onClick={onClick}
        className="inline-flex size-11 items-center justify-center rounded-md text-muted-foreground transition hover:bg-accent hover:text-foreground active:scale-95 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/25 sm:size-9"
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
      className={`rounded-sm p-1.5 transition hover:bg-secondary active:scale-95 ${
        active ? "text-primary" : "text-muted-foreground"
      }`}
    >
      {children}
    </button>
  );
}
