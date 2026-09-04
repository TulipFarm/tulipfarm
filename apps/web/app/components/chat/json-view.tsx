import { type ReactNode, useState } from "react";
import { ChevronRight } from "~/components/icons";
import type { ToolPreview } from "~/lib/chat/types";
import { cn } from "~/lib/utils";
import { formatBytes } from "./tool-summary";

/** Withheld leaves render as `redacted` so hidden and absent stay distinct. */

/** Values deeper than this start collapsed, so a large payload opens as an outline. */
const AUTO_COLLAPSE_DEPTH = 2;
const REDACTED_MARKER = "[redacted]";

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

function Punctuation({ children }: { children: ReactNode }) {
  return <span className="text-muted-foreground">{children}</span>;
}

function Scalar({ value }: { value: string | number | boolean | null }) {
  if (value === null) return <span className="text-code-null">null</span>;
  if (typeof value === "boolean") return <span className="text-code-boolean">{String(value)}</span>;
  if (typeof value === "number") {
    return <span className="text-code-number tabular-nums">{value}</span>;
  }
  if (value === REDACTED_MARKER) {
    return (
      <span className="inline-flex items-center gap-1 rounded-sm bg-code-redacted/15 px-1.5 py-px text-code-redacted">
        <span aria-hidden>••••••</span>
        <span className="text-xs">Redacted</span>
      </span>
    );
  }
  return <span className="text-code-string">"{value}"</span>;
}

function Branch({
  value,
  depth,
  path,
}: {
  value: JsonValue[] | { [key: string]: JsonValue };
  depth: number;
  path: string;
}) {
  const [open, setOpen] = useState(depth < AUTO_COLLAPSE_DEPTH);
  const isArray = Array.isArray(value);
  const entries: [string, JsonValue][] = isArray
    ? value.map((item, index) => [String(index), item])
    : Object.entries(value);
  const [openBrace, closeBrace] = isArray ? ["[", "]"] : ["{", "}"];

  if (entries.length === 0) {
    return (
      <Punctuation>
        {openBrace}
        {closeBrace}
      </Punctuation>
    );
  }

  return (
    <span>
      <button
        type="button"
        onClick={() => setOpen((previous) => !previous)}
        aria-expanded={open}
        className="inline-flex min-h-6 items-center gap-0.5 rounded-sm px-1 text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronRight
          aria-hidden
          className={cn(
            "size-3 transition-transform duration-100 ease-snappy",
            open && "rotate-90"
          )}
        />
        <span>{openBrace}</span>
      </button>
      {open ? (
        <>
          <span className="block border-l border-code-border pl-3">
            {entries.map(([key, child]) => (
              <span key={`${path}.${key}`} className="block">
                {isArray ? null : (
                  <>
                    <span className="text-code-key">"{key}"</span>
                    <Punctuation>: </Punctuation>
                  </>
                )}
                <Node value={child} depth={depth + 1} path={`${path}.${key}`} />
              </span>
            ))}
          </span>
          <Punctuation>{closeBrace}</Punctuation>
        </>
      ) : (
        <Punctuation>
          {" "}
          {entries.length} {entries.length === 1 ? "entry" : "entries"} {closeBrace}
        </Punctuation>
      )}
    </span>
  );
}

function Node({ value, depth, path }: { value: JsonValue; depth: number; path: string }) {
  if (value !== null && typeof value === "object") {
    return <Branch value={value} depth={depth} path={path} />;
  }
  return <Scalar value={value} />;
}

/** Invalid previews render verbatim instead of disappearing. */
export function JsonView({ json }: { json: string }) {
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(json) as JsonValue;
  } catch {
    return (
      <pre className="overflow-x-auto whitespace-pre-wrap break-all font-mono text-xs text-muted-foreground">
        {json}
      </pre>
    );
  }

  return (
    <div className="overflow-x-auto font-mono text-xs leading-relaxed">
      <Node value={parsed} depth={0} path="$" />
    </div>
  );
}

/** The honest footer under a preview: what was withheld, and how much is missing. */
export function PreviewNotice({ preview }: { preview: ToolPreview }) {
  const redactedCount = preview.redactedPaths?.length ?? 0;
  const size = formatBytes(preview.bytes);

  if (redactedCount === 0 && preview.truncated !== true) return null;

  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-code-border px-3 py-1.5 text-[11px] text-muted-foreground">
      {redactedCount > 0 ? (
        <span className="text-code-redacted">
          {redactedCount} {redactedCount === 1 ? "field" : "fields"} withheld
        </span>
      ) : null}
      {preview.truncated === true ? (
        <span>Shortened for display{size === undefined ? "" : ` · ${size} total`}</span>
      ) : null}
    </p>
  );
}
