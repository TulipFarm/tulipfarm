import { useState } from "react";
import { Check, Copy } from "~/components/icons";
import type { TimelinePart, ToolPreview } from "~/lib/chat/types";
import { copyText } from "~/lib/clipboard";
import { cn } from "~/lib/utils";
import { JsonView, PreviewNotice } from "./json-view";
import { toolFamily, toolTierLabel } from "./tool-summary";

type ToolPart = Extract<TimelinePart, { kind: "tool" }>;

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      onClick={async () => {
        if (await copyText(value)) {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1_400);
        }
      }}
      aria-label={label}
      className="inline-flex min-h-6 items-center gap-1 rounded-sm px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-run-surface-hover hover:text-foreground"
    >
      {copied ? <Check aria-hidden className="size-3" /> : <Copy aria-hidden className="size-3" />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function InspectPane({
  label,
  preview,
  fallback,
}: {
  label: string;
  preview?: ToolPreview;
  fallback?: unknown;
}) {
  const json =
    preview?.json ?? (fallback === undefined ? undefined : JSON.stringify(fallback, null, 2));
  if (json === undefined) return null;

  return (
    <section className="overflow-hidden rounded-md border border-code-border bg-code-surface">
      <header className="flex items-center justify-between gap-2 border-b border-code-border px-3 py-1.5">
        <h4 className="font-mono text-xs font-medium text-muted-foreground">{label}</h4>
        <CopyButton value={json} label={`Copy ${label.toLowerCase()}`} />
      </header>
      <div className="px-3 py-2">
        <JsonView json={json} />
      </div>
      {preview === undefined ? null : <PreviewNotice preview={preview} />}
    </section>
  );
}

/**
 * The verbatim evidence behind one Tool call: what went in, what came back, and the identifiers
 * that let an operator find it again. Lives behind a step on the trace, so a reader who opens a
 * step gets the verbatim evidence and not a summary of it.
 */
export function ToolInspector({ part }: { part: ToolPart }) {
  const tier = toolTierLabel(part.meta?.tier, toolFamily(part.toolName));
  return (
    <div className="space-y-2">
      <InspectPane label="Input" preview={part.argsPreview} fallback={parsedArgs(part)} />
      <InspectPane label="Output" preview={part.resultPreview} fallback={parsedResult(part)} />
      <dl className="flex flex-wrap items-center gap-x-4 gap-y-1 px-0.5 text-[11px] text-muted-foreground">
        <Meta label="Tier" value={tier} />
        {part.meta?.agentId === undefined ? null : <Meta label="Agent" value={part.meta.agentId} />}
        <Meta label="Call" value={part.toolCallId} mono />
        {digestOf(part) === undefined ? null : (
          <Meta label="Digest" value={digestOf(part) ?? ""} mono />
        )}
      </dl>
    </div>
  );
}

/**
 * Whether there is anything to open. Derived from the previews rather than the parsed values: an
 * unparseable preview still has a truncation notice to show, and deriving it from `parsedArgs`
 * once made such a row silently refuse to expand.
 */
export function toolHasDetails(part: ToolPart): boolean {
  return (
    part.argsPreview !== undefined ||
    part.resultPreview !== undefined ||
    parsedArgs(part) !== undefined ||
    parsedResult(part) !== undefined
  );
}

function Meta({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <span className="flex items-center gap-1.5">
      <dt className=" opacity-70">{label}</dt>
      <dd className={cn("text-foreground/80", mono === true && "font-mono")}>{value}</dd>
    </span>
  );
}

/** Live `args` may be only `{ argsDigest }`; show it as metadata, not arguments. */
function parsedArgs(part: ToolPart): unknown {
  if (part.argsPreview !== undefined) {
    try {
      return JSON.parse(part.argsPreview.json);
    } catch {
      return undefined;
    }
  }
  if (isDigestOnly(part.args)) return undefined;
  return part.args;
}

function isDigestOnly(args: unknown): boolean {
  if (typeof args !== "object" || args === null) return false;
  const keys = Object.keys(args);
  return keys.length === 0 || (keys.length === 1 && keys[0] === "argsDigest");
}

/** Keep the digest so a redacted call remains verifiable. */
function digestOf(part: ToolPart): string | undefined {
  if (part.meta?.argsDigest !== undefined) return part.meta.argsDigest;
  if (typeof part.args !== "object" || part.args === null) return undefined;
  const digest = (part.args as { argsDigest?: unknown }).argsDigest;
  return typeof digest === "string" ? digest : undefined;
}

/** The result to show. Same rule as the arguments: preview first, verbatim second. */
function parsedResult(part: ToolPart): unknown {
  if (part.resultPreview !== undefined) {
    try {
      return JSON.parse(part.resultPreview.json);
    } catch {
      return undefined;
    }
  }
  return part.result;
}
