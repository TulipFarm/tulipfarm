import { Bug, Check, Copy, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { CodeBlock, CollapsibleSection } from "~/components/chat/debug-code";
import { copyText } from "~/lib/clipboard";
import { type DebugContext, type DebugTool, getDebugContext } from "~/lib/conversations";
import { cn } from "~/lib/utils";

/** A line that is nothing but one `<block>` or `</block>` tag, which is how prompt blocks open. */
const PROMPT_TAG_LINE = /^<(\/?)([a-z][a-z0-9-]*)>$/;

interface PromptBlock {
  readonly tag: string;
  readonly body: string;
}

/** One row of the message list as the drawer shows it — persisted rows plus the synthetic ones. */
type DebugRow = {
  _id: string;
  role: string;
  content: unknown;
  metadata?: Record<string, unknown>;
  createdAt: string | null;
};

/**
 * Splits the assembled prompt into its top-level `<block>` sections.
 *
 * The prompt is only ever a sequence of whole-line-delimited blocks, so this needs no parser. Text
 * outside any block — which `assembleSystemPrompt` does not currently emit — is kept under a
 * `(untagged)` heading rather than dropped, because a debug view that hides part of its subject is
 * worse than an ugly one.
 */
export function splitPromptBlocks(text: string): PromptBlock[] {
  const blocks: PromptBlock[] = [];
  let tag: string | null = null;
  let buffer: string[] = [];
  const flush = (name: string) => {
    if (buffer.length > 0 || name !== "(untagged)") {
      blocks.push({ tag: name, body: buffer.join("\n").trim() });
    }
    buffer = [];
  };
  for (const line of text.split("\n")) {
    const match = PROMPT_TAG_LINE.exec(line);
    if (match && match[1] === "" && tag === null) {
      if (buffer.some((l) => l.trim().length > 0)) flush("(untagged)");
      buffer = [];
      tag = match[2] ?? null;
      continue;
    }
    if (match && match[1] === "/" && tag === match[2]) {
      flush(`<${tag}>`);
      tag = null;
      continue;
    }
    buffer.push(line);
  }
  if (buffer.some((l) => l.trim().length > 0)) flush(tag === null ? "(untagged)" : `<${tag}>`);
  return blocks;
}

function tokenCount(text: string): string {
  return `${text.length.toLocaleString()} chars`;
}

const TABS = [
  { id: "prompt", label: "Prompt" },
  { id: "tools", label: "Tools" },
  { id: "json", label: "JSON" },
] as const;

type DebugTab = (typeof TABS)[number]["id"];

/**
 * A floating button opens a non-blocking right slide-over over the raw conversation state, in two
 * views: the messages the LLM receives (the reconstructed system prompt plus the Soul reminder)
 * rendered as highlighted Markdown, and every persisted row (all roles, tool calls/results,
 * metadata) as highlighted JSON. Both views are collapsible per block, and either copies whole, so
 * a dev can paste the exact agent context into external pipelines. Gated on `import.meta.env.DEV`:
 * the whole component (and its dynamic imports) dead-code-strips out of the production bundle, and
 * the backing API route is registered only outside production.
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
  const [toolFilter, setToolFilter] = useState("");
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

  // Mirrors the message list a Turn actually sends: the system prompt, then the Soul reminder as
  // the user-role message it really is, then the persisted rows. Neither synthetic row is stored,
  // so a view that showed only the table would omit half of what the model was given.
  const rows: DebugRow[] = data
    ? [
        {
          _id: "system-prompt",
          role: "system",
          content: data.systemPrompt,
          metadata: { synthetic: true },
          createdAt: null,
        },
        ...(data.soulReminder
          ? [
              {
                _id: "soul-reminder",
                role: "user",
                content: data.soulReminder,
                metadata: { synthetic: true },
                createdAt: null,
              },
            ]
          : []),
        ...data.messages,
      ]
    : [];

  const json = data
    ? JSON.stringify({ conversationId: data.conversationId, messages: rows }, null, 2)
    : "";
  const promptText = data
    ? [data.systemPrompt, data.soulReminder].filter((part) => part.length > 0).join("\n")
    : "";
  const toolsJson = data ? JSON.stringify(data.tools, null, 2) : "";
  const copyPayload = tab === "prompt" ? promptText : tab === "tools" ? toolsJson : json;

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
        title={conversationId ? "Debug, raw state" : "Send a message first"}
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
          aria-label="Debug, Raw State"
          className="fixed top-0 right-0 z-50 flex h-svh w-[min(34rem,90vw)] flex-col border-l border-border bg-card shadow-lg motion-safe:animate-in motion-safe:slide-in-from-right motion-safe:duration-200"
        >
          <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
            <span className="text-xs font-medium text-foreground">Debug, Raw State</span>
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
                No conversation yet. Send a message first.
              </p>
            ) : loading && !data ? (
              <p className="p-3 text-xs text-muted-foreground">loading…</p>
            ) : err ? (
              <p className="p-3 text-xs text-destructive">[error] {err}</p>
            ) : tab === "prompt" ? (
              <PromptView data={data} />
            ) : tab === "tools" ? (
              <ToolsView
                tools={data?.tools ?? []}
                filter={toolFilter}
                onFilterChange={setToolFilter}
              />
            ) : (
              <JsonView conversationId={data?.conversationId ?? ""} rows={rows} />
            )}
          </div>
        </aside>
      ) : null}
    </>
  );
}

function PromptView({ data }: { data: DebugContext | null }) {
  if (!data) return null;
  const blocks = splitPromptBlocks(data.systemPrompt);
  return (
    <div>
      {blocks.map((block, i) => (
        <CollapsibleSection
          key={`${i}:${block.tag}`}
          title={block.tag}
          meta={tokenCount(block.body)}
        >
          <CodeBlock code={block.body} lang="markdown" />
        </CollapsibleSection>
      ))}
      {data.soulReminder ? (
        <CollapsibleSection
          title="<system-reminder> (injected as a user message)"
          meta={tokenCount(data.soulReminder)}
        >
          <CodeBlock code={data.soulReminder} lang="markdown" />
        </CollapsibleSection>
      ) : (
        <p className="px-2 py-1.5 text-[0.6875rem] text-muted-foreground">
          No Soul reminder for this reader.
        </p>
      )}
    </div>
  );
}

/** Each Tool exactly as it was sent to the model this Turn: name, description, resolved schema. */
function ToolsView({
  tools,
  filter,
  onFilterChange,
}: {
  tools: readonly DebugTool[];
  filter: string;
  onFilterChange: (value: string) => void;
}) {
  const matched = tools.filter((t) => t.name.toLowerCase().includes(filter.trim().toLowerCase()));
  return (
    <div>
      <div className="sticky top-0 z-10 border-b border-border bg-card px-2 py-1.5">
        <input
          type="text"
          value={filter}
          onChange={(e) => onFilterChange(e.target.value)}
          placeholder="Filter tools by name…"
          className="w-full rounded-sm border border-border bg-background px-2 py-1 text-[0.6875rem] outline-none focus:border-primary/60"
        />
      </div>
      {matched.length === 0 ? (
        <p className="px-2 py-1.5 text-[0.6875rem] text-muted-foreground">
          {tools.length === 0
            ? "No Tools available to this Agent for this channel."
            : "No Tools match."}
        </p>
      ) : (
        matched.map((t) => (
          <CollapsibleSection
            key={t.name}
            title={t.name}
            meta={tokenCount(JSON.stringify(t.inputSchema))}
            defaultOpen={false}
          >
            <p className="px-2 pt-1.5 pb-1 text-[0.6875rem] text-muted-foreground">
              {t.description}
            </p>
            <CodeBlock code={JSON.stringify(t.inputSchema, null, 2)} lang="json" />
          </CollapsibleSection>
        ))
      )}
    </div>
  );
}

function JsonView({ conversationId, rows }: { conversationId: string; rows: DebugRow[] }) {
  return (
    <div>
      <p className="border-b border-border px-2 py-1.5 font-mono text-[0.625rem] text-muted-foreground">
        conversationId: {conversationId}
      </p>
      {rows.map((row, i) => {
        const body = JSON.stringify(row, null, 2);
        const synthetic = (row.metadata as { synthetic?: boolean } | undefined)?.synthetic === true;
        return (
          <CollapsibleSection
            key={row._id}
            title={`[${i}] ${row.role}${synthetic ? " · synthetic" : ""}`}
            meta={tokenCount(body)}
            defaultOpen={!synthetic}
          >
            <CodeBlock code={body} lang="json" />
          </CollapsibleSection>
        );
      })}
    </div>
  );
}
