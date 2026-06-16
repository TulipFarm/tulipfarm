import { Bug, Check, Copy, RefreshCw, X } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { type DebugContext, getDebugContext } from "~/lib/conversations";
import { cn } from "~/lib/utils";

// Minimal, dependency-free JSON syntax highlighter. Tokenizes strings (key vs value), numbers, and
// literals into React spans — text content is React-escaped, so there is no innerHTML/XSS surface.
// Colors use the `dark:` variant (wired to [data-theme="dark"] in app.css); structural chars (braces,
// commas, colons) inherit the <pre>'s muted color so the values pop.
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
      // A string immediately followed by `:` is an object key.
      cls = /^\s*:/.test(json.slice(m.index + tok.length))
        ? "text-sky-700 dark:text-sky-300"
        : "text-emerald-700 dark:text-emerald-400";
    } else if (tok === "true" || tok === "false" || tok === "null") {
      cls = "text-fuchsia-700 dark:text-fuchsia-300";
    } else {
      cls = "text-amber-700 dark:text-amber-300";
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

/**
 * Dev-only chat debug drawer. A floating button opens a non-blocking right slide-over that dumps the
 * full raw conversation state — the system prompt the LLM receives (reconstructed server-side) plus
 * every persisted row (all roles, tool calls/results, metadata) — as copyable JSON, so a dev can paste
 * the exact agent context into external pipelines. Gated on `import.meta.env.DEV`: the whole component
 * (and its dynamic imports) dead-code-strips out of the production bundle, and the backing API route is
 * registered only outside production.
 */
export function ChatDebugDrawer({ conversationId }: { conversationId?: string }) {
  if (!import.meta.env.DEV) return null;
  return <DebugDrawer conversationId={conversationId} />;
}

function DebugDrawer({ conversationId }: { conversationId?: string }) {
  const [open, setOpen] = useState(false);
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

  // Snapshot on open (and on Refresh). A turn streaming right now shows up once it persists.
  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  // Close on Escape or an outside click — no blocking backdrop, so the chat stays interactive
  // (mirrors the model-selector dropdown). The listeners attach only while open.
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

  // Compose the displayed payload in the ticket's shape: the system prompt as the first role:"system"
  // entry (clearly marked synthetic — it is reconstructed, not a stored row), then the raw rows.
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

  async function copy() {
    try {
      await navigator.clipboard.writeText(json);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable (non-secure context) — no-op
    }
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
                aria-label={copied ? "Copied" : "Copy JSON"}
                onClick={copy}
                disabled={!json}
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
                {highlightJson(json)}
              </pre>
            )}
          </div>
        </aside>
      ) : null}
    </>
  );
}
