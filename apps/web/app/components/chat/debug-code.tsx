import { ChevronRight } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useHighlighted } from "~/lib/use-highlighted";
import { cn } from "~/lib/utils";

/**
 * One Shiki-highlighted block, falling back to plain text.
 *
 * `useHighlighted` returns `null` while the lazy grammar chunk loads and whenever it fails, so
 * the fallback is not an error path — it is what every block renders as on first paint.
 */
export function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const html = useHighlighted(code, lang);
  const shell =
    "px-3 py-2 text-[0.6875rem] leading-relaxed [&_pre]:whitespace-pre-wrap [&_pre]:break-words [&_pre]:bg-transparent [&_code]:whitespace-pre-wrap";
  if (html === null) {
    return (
      <pre className={cn(shell, "whitespace-pre-wrap break-words text-muted-foreground")}>
        {code}
      </pre>
    );
  }
  return (
    <div
      className={shell}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: Shiki output is static, HTML-escaped text from this deployment's own authed debug route.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/**
 * A collapsible block. The body is mounted only while open, so collapsing a section also stops
 * paying to highlight it — the system prompt alone is several thousand tokens of Markdown.
 */
export function CollapsibleSection({
  title,
  meta,
  defaultOpen = true,
  children,
}: {
  title: string;
  meta?: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="border-b border-border last:border-b-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left transition-colors hover:bg-accent"
      >
        <ChevronRight
          aria-hidden="true"
          className={cn(
            "size-3 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90"
          )}
        />
        <span className="truncate font-mono text-[0.6875rem] text-foreground">{title}</span>
        {meta ? (
          <span className="ml-auto shrink-0 text-[0.625rem] text-muted-foreground">{meta}</span>
        ) : null}
      </button>
      {open ? children : null}
    </section>
  );
}
