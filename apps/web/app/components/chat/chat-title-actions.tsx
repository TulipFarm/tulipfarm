import { CHAT_TITLE_MAX_LENGTH } from "@tulipfarm/schema/chat";
import { MoreHorizontal, Pencil, Star, Trash2 } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ConfirmModal } from "~/components/ui/modal";
import { Tooltip } from "~/components/ui/tooltip";
import type { ConversationSummary } from "~/lib/conversations";
import { useConversations } from "~/lib/conversations-context";
import { cn } from "~/lib/utils";

/*
 * Rename + delete for one chat, shared by the Chats page, the sidebar's Recent chats and the top
 * bar. Those three surfaces each used to be the only place a chat could be managed from; keeping
 * one menu, one input and one state machine here is what stops their limits, labels, keyboard
 * behaviour and failure handling drifting.
 */

/** Remaining-characters hint appears only this close to the ceiling, so it is a warning, not noise. */
const COUNTER_VISIBLE_WITHIN = 20;

/**
 * Inline rename field. Enter saves, Escape cancels, blur saves. The value is hard-capped at
 * `CHAT_TITLE_MAX_LENGTH` — the same ceiling the API enforces — and a live counter appears as the
 * user approaches it, so a truncated title is never a surprise.
 */
export function ChatTitleInput({
  initialTitle,
  onSave,
  onCancel,
  className,
  label = "Rename chat",
}: {
  initialTitle: string;
  onSave: (title: string) => void;
  onCancel: () => void;
  className?: string;
  label?: string;
}) {
  const [value, setValue] = useState(() => initialTitle.slice(0, CHAT_TITLE_MAX_LENGTH));
  const counterId = useId();
  // Enter/Escape commit then unmount the input, which fires a trailing blur — `done` makes that blur
  // a no-op so we neither save twice nor save after an Escape-cancel.
  const done = useRef(false);
  const commit = (fn: () => void) => {
    if (done.current) return;
    done.current = true;
    fn();
  };
  const remaining = CHAT_TITLE_MAX_LENGTH - value.length;
  const showCounter = remaining <= COUNTER_VISIBLE_WITHIN;
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <input
        // biome-ignore lint/a11y/noAutofocus: focus belongs on the field the user just chose to edit
        autoFocus
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value.slice(0, CHAT_TITLE_MAX_LENGTH))}
        onFocus={(e) => e.currentTarget.select()}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit(() => onSave(value));
          else if (e.key === "Escape") commit(onCancel);
        }}
        onBlur={() => commit(() => onSave(value))}
        aria-label={label}
        aria-describedby={showCounter ? counterId : undefined}
        maxLength={CHAT_TITLE_MAX_LENGTH}
        className={cn(
          "h-10 min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/25",
          className
        )}
      />
      {showCounter ? (
        <span
          id={counterId}
          aria-live="polite"
          className={cn(
            "shrink-0 text-xs tabular-nums",
            remaining === 0 ? "text-destructive" : "text-muted-foreground"
          )}
        >
          {remaining}
        </span>
      ) : null}
    </div>
  );
}

/**
 * Per-chat actions, portalled so a scrolling panel never clips the menu (mirrors the composer's
 * ModelSelector). Closes on outside-click, Escape, or any scroll/resize. `starred` is omitted where
 * the surface has no room to show the flag it would toggle.
 *
 * The hover reveal is owned here, not by callers: touch devices have no hover, so below `sm` the
 * trigger stays visible at a 44px target. A caller that supplied its own reveal could silently make
 * rename and delete unreachable on a phone, which is exactly what happened once already.
 * `triggerClassName` is for positioning only.
 */
export function ChatActionsMenu({
  starred,
  onToggleStar,
  onStartRename,
  onDelete,
  triggerClassName,
  align = "right",
}: {
  starred?: boolean;
  onToggleStar?: () => void;
  onStartRename: () => void;
  onDelete: () => void;
  /** Positioning only — sizing and reveal are fixed, see above. */
  triggerClassName?: string;
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!triggerRef.current?.contains(target) && !menuRef.current?.contains(target)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const close = () => setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  function toggle(e: React.MouseEvent) {
    // The trigger often sits inside a row-wide <Link>; without this a click would also navigate.
    e.preventDefault();
    e.stopPropagation();
    if (!open && triggerRef.current) setRect(triggerRef.current.getBoundingClientRect());
    setOpen((o) => !o);
  }

  const itemClass =
    "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-foreground transition-colors hover:bg-secondary";

  function choose(action: () => void) {
    return (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      action();
    };
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Chat actions"
        onClick={toggle}
        className={cn(
          "inline-flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-accent hover:text-foreground active:scale-95 sm:size-9 sm:opacity-0 sm:focus-visible:opacity-100 sm:group-hover:opacity-100",
          triggerClassName,
          open && "opacity-100"
        )}
      >
        <MoreHorizontal className="size-4" />
      </button>

      {open && rect
        ? createPortal(
            <div
              ref={menuRef}
              role="menu"
              className="fixed z-50 w-40 rounded-sm border border-border bg-card p-1 text-xs"
              style={
                align === "right"
                  ? { top: rect.bottom + 4, right: window.innerWidth - rect.right }
                  : { top: rect.bottom + 4, left: rect.left }
              }
            >
              {onToggleStar ? (
                <button
                  type="button"
                  role="menuitem"
                  onClick={choose(onToggleStar)}
                  className={itemClass}
                >
                  <Star className={cn("size-3.5", starred && "fill-primary text-primary")} />
                  {starred ? "Unstar" : "Star"}
                </button>
              ) : null}
              <button
                type="button"
                role="menuitem"
                onClick={choose(onStartRename)}
                className={itemClass}
              >
                <Pencil className="size-3.5" />
                Rename
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={choose(onDelete)}
                className={`${itemClass} text-destructive hover:bg-destructive/10`}
              >
                <Trash2 className="size-3.5" />
                Delete
              </button>
            </div>,
            document.body
          )
        : null}
    </>
  );
}

/** The one delete confirmation for chats, so its warning reads the same wherever it is raised. */
export function DeleteChatModal({
  title,
  open,
  busy,
  error,
  onClose,
  onConfirm,
}: {
  title: string | null;
  open: boolean;
  busy: boolean;
  /** A refused delete (409 while a Turn runs) must be readable from inside the dialog. */
  error?: string | null;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <ConfirmModal
      open={open}
      onClose={onClose}
      onConfirm={onConfirm}
      title="Delete chat"
      description={`Permanently delete “${title ?? "New chat"}” and all of its messages? This cannot be undone.`}
      busy={busy}
      error={error}
    />
  );
}

/** The least a surface must know about a chat to rename or delete it. */
export type ChatTarget = { id: string; title: string | null };

/**
 * The rename/delete state machine every chat surface needs: which row is in edit mode, which is
 * awaiting confirmation, whether a request is in flight, and the last failure.
 *
 * It lives here rather than in each surface because all three previously kept their own copy, and
 * the copies had already drifted — one of them left a refused delete's dialog open with the error
 * rendered behind the backdrop. `onRenamed`/`onDeleted` exist for surfaces holding a list of their
 * own; the shared context is updated either way.
 */
export function useChatTitleActions({
  onRenamed,
  onDeleted,
}: {
  onRenamed?: (updated: ConversationSummary) => void;
  onDeleted?: (id: string) => void;
} = {}) {
  const { renameChat, removeChat } = useConversations();
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ChatTarget | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submitRename(id: string, title: string) {
    const next = title.trim();
    setRenamingId(null);
    if (!next) return;
    try {
      const updated = await renameChat(id, next);
      setError(null);
      onRenamed?.(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not rename chat");
    }
  }

  async function confirmDelete() {
    const target = pendingDelete;
    if (!target) return;
    setDeleting(true);
    setError(null);
    try {
      await removeChat(target.id);
      setPendingDelete(null);
      onDeleted?.(target.id);
    } catch (err) {
      // The dialog stays open: it is the only surface still reachable behind `showModal`.
      setError(err instanceof Error ? err.message : "could not delete chat");
    } finally {
      setDeleting(false);
    }
  }

  return {
    renamingId,
    startRename: (id: string) => {
      setError(null);
      setRenamingId(id);
    },
    cancelRename: () => setRenamingId(null),
    submitRename: (id: string, title: string) => void submitRename(id, title),
    pendingDelete,
    requestDelete: (target: ChatTarget) => {
      setError(null);
      setPendingDelete(target);
    },
    cancelDelete: () => {
      setError(null);
      setPendingDelete(null);
    },
    confirmDelete: () => void confirmDelete(),
    deleting,
    error,
    setError,
  };
}

/**
 * The open chat's name in the top bar, made editable in place, with its own rename/delete menu.
 * This is the one surface where the open chat is always named — the sidebar list only reaches back
 * so far, and the Chats page is a navigation away from the transcript on screen.
 *
 * `title` is the stored title, or `null` while the async titler has yet to name the chat. The
 * placeholder shown in that window is deliberately not seeded into the edit field, which would
 * otherwise offer "New chat" as if the user had chosen it.
 */
export function ChatCrumbTitle({ chatId, title }: { chatId: string; title: string | null }) {
  const actions = useChatTitleActions();
  const display = title ?? "New chat";

  if (actions.renamingId === chatId) {
    return (
      <div className="w-52 sm:w-80">
        <ChatTitleInput
          initialTitle={title ?? ""}
          onSave={(next) => actions.submitRename(chatId, next)}
          onCancel={actions.cancelRename}
          className="h-8 text-sm"
          label="Rename this chat"
        />
      </div>
    );
  }

  return (
    <span className="group flex min-w-0 items-center gap-1">
      <Tooltip content="Rename this chat">
        <button
          type="button"
          onClick={() => actions.startRename(chatId)}
          aria-current="page"
          aria-label={`Rename this chat: ${display}`}
          className="min-w-0 truncate rounded-md px-1 text-left text-sm font-medium text-foreground transition-colors duration-150 hover:bg-accent"
        >
          {display}
        </button>
      </Tooltip>
      <ChatActionsMenu
        onStartRename={() => actions.startRename(chatId)}
        onDelete={() => actions.requestDelete({ id: chatId, title })}
        align="left"
      />
      {actions.error && !actions.pendingDelete ? (
        <span role="alert" className="min-w-0 max-w-40 truncate text-xs text-destructive">
          {actions.error}
        </span>
      ) : null}
      <DeleteChatModal
        open={actions.pendingDelete !== null}
        onClose={actions.cancelDelete}
        onConfirm={actions.confirmDelete}
        title={title}
        busy={actions.deleting}
        error={actions.error}
      />
    </span>
  );
}
