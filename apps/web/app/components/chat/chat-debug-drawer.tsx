import { Bug, Check, Copy, RefreshCw, X } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { copyText } from "~/lib/clipboard";
import { type DebugContext, getDebugContext } from "~/lib/conversations";
import { cn } from "~/lib/utils";

const JSON_TOKEN =
  /"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\btrue\b|\bfalse\b|\bnull\b/g;

function highlightJson(json: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  JSON_TOKEN.lastIndex = 0;
  for (let m = JSON_TOKEN.exec(json); m !== null; m = JSON_TOKEN.exec(json)) {
    const tok = m[0];
    if (m.index > last) out.push(json.slice(last, m.index));
    let cls: string;
    if (tok[0] === '"') {
      cls = /^\s*:/.test(json.slice(m.index + tok.length)) ? "text-code-key" : "text-code-string";
    } else if (tok === "true" || tok === "false") {
      cls = "text-code-boolean";
    } else if (tok === "null") {
      cls = "text-code-null";
    } else {
      cls = "text-code-number tabular-nums";
    }
    out.push(
      <span key={key} className={cls}>
        {tok}
      </span>
    );
    key += 1;
    last = m.index + tok.length;
  }
  if (last < json.length) out.push(json.slice(last));
  return out;
}

/** A line that is nothing but one `<block>` or `</block>` tag, which is how prompt blocks open. */
const PROMPT_TAG_LINE = /^<\/?[a-z][a-z0-9-]*>$/;
const PROMPT_INLINE_CODE = /`[^`\n]+`/g;

function highlightInlineCode(line: string, lineIndex: number): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  PROMPT_INLINE_CODE.lastIndex = 0;
  for (let m = PROMPT_INLINE_CODE.exec(line); m !== null; m = PROMPT_INLINE_CODE.exec(line)) {
    if (m.index > last) out.push(line.slice(last, m.index));
    out.push(
      <span key={`${lineIndex}:${key}`} className="text-code-string">
        {m[0]}
      </span>
    );
    key += 1;
    last = m.index + m[0].length;
  }
  if (last < line.length) out.push(line.slice(last));
  return out;
}

/**
 * Renders the assembled prompt as text rather than as an escaped JSON string, because every
 * newline in it is what separates one block from the next — collapsed to `\n` the whole prompt
 * reads as one paragraph and its structure is invisible.
 */
function highlightPrompt(text: string): ReactNode[] {
  const lines = text.split("\n");
  const out: ReactNode[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const prefix = i === 0 ? "" : "\n";
    if (PROMPT_TAG_LINE.test(line)) {
      out.push(
        <span key={i} className="font-medium text-code-key">
          {prefix}
          {line}
        </span>
      );
    } else if (line.startsWith("#")) {
      out.push(
        <span key={i} className="font-medium text-code-boolean">
          {prefix}
          {line}
        </span>
      );
    } else {
      out.push(
        <span key={i}>
          {prefix}
          {highlightInlineCode(line, i)}
        </span>
      );
    }
  }
  return out;
}

const TABS = [
  { id: "prompt", label: "Prompt" },
  { id: "json", label: "JSON" },
] as const;

type DebugTab = (typeof TABS)[number]["id"];

/**
 * A floating button opens a non-blocking right slide-over over the raw conversation state, in two
 * views: the system prompt the LLM receives (reconstructed server-side) rendered as formatted
 * text, and every persisted row (all roles, tool calls/results, metadata) as JSON. Either view
 * copies, so a dev can paste the exact agent context into external pipelines. Gated on
 * `import.meta.env.DEV`: the whole component (and its dynamic imports) dead-code-strips out of the
 * production bundle, and the backing API route is registered only outside production.
 */
export function ChatDebugDrawer({ conversationId }: { conversationId?: string }) {
  if (!import.meta.env.DEV) return null;
  return <DebugDrawer conversationId={conversationId} />;
}

function DebugDrawer({ conversationId }: { conversationId?: string }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<DebugTab>("prompt");
  const [data, setData] = useState<DebugContext | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const panelRef = useRef<HTMLElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const load = useCallback(async () => {
    if (!conversationId) return;
    setLoading(true);
    setErr(null);
    try {
      setData(await getDebugContext(conversationId));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "failed to load debug context");
    } finally {
      setLoading(false);
    }
  }, [conversationId]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!panelRef.current?.contains(t) && !triggerRef.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const json = data
    ? JSON.stringify(
        {
          conversationId: data.conversationId,
          messages: [
            {
              _id: "system-prompt",
              role: "system",
              content: data.systemPrompt,
              metadata: { synthetic: true },
              createdAt: null,
            },
            ...data.messages,
          ],
        },
        null,
        2
      )
    : "";
  const copyPayload = tab === "prompt" ? (data?.systemPrompt ?? "") : json;

  async function copy() {
    if (!(await copyText(copyPayload))) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  const iconBtn =
    "rounded-sm p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40";

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label="Open debug drawer"
        title={conversationId ? "Debug — raw state" : "Send a message first"}
        disabled={!conversationId}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "fixed right-3 bottom-3 z-50 inline-flex size-9 items-center justify-center rounded-full border border-border bg-card text-muted-foreground shadow-sm transition-colors",
          "hover:border-primary/60 hover:text-foreground disabled:opacity-40 disabled:hover:border-border disabled:hover:text-muted-foreground"
        )}
      >
        <Bug className="size-4" />
      </button>

      {open ? (
        <aside
          ref={panelRef}
          aria-label="Debug — Raw State"
          className="fixed top-0 right-0 z-50 flex h-svh w-[min(34rem,90vw)] flex-col border-l border-border bg-card shadow-lg motion-safe:animate-in motion-safe:slide-in-from-right motion-safe:duration-200"
        >
          <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
            <span className="text-xs font-medium text-foreground">Debug — Raw State</span>
            <div className="flex items-center gap-0.5 rounded-sm border border-border p-0.5">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  aria-pressed={tab === t.id}
                  onClick={() => setTab(t.id)}
                  className={cn(
                    "rounded-[0.1875rem] px-2 py-0.5 text-[0.6875rem] transition-colors",
                    tab === t.id
                      ? "bg-accent text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <div className="ml-auto flex items-center gap-1">
              <button
                type="button"
                aria-label="Refresh"
                onClick={() => void load()}
                disabled={loading}
                className={iconBtn}
              >
                <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
              </button>
              <button
                type="button"
                aria-label={copied ? "Copied" : "Copy"}
                onClick={copy}
                disabled={!copyPayload}
                className={iconBtn}
              >
                {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
              </button>
              <button
                type="button"
                aria-label="Close"
                onClick={() => setOpen(false)}
                className={iconBtn}
              >
                <X className="size-4" />
              </button>
            </div>
          </header>
          <div className="min-h-0 flex-1 overflow-auto">
            {!conversationId ? (
              <p className="p-3 text-xs text-muted-foreground">
                No conversation yet — send a message first.
              </p>
            ) : loading && !data ? (
              <p className="p-3 text-xs text-muted-foreground">loading…</p>
            ) : err ? (
              <p className="p-3 text-xs text-destructive">[error] {err}</p>
            ) : (
              <pre className="whitespace-pre-wrap break-words p-3 text-[0.6875rem] leading-relaxed text-muted-foreground">
                {tab === "prompt" ? highlightPrompt(data?.systemPrompt ?? "") : highlightJson(json)}
              </pre>
            )}
          </div>
        </aside>
      ) : null}
    </>
  );
}
