import { useEffect, useState } from "react";
import { Panel } from "~/components/ui/panel";
import { getMemoryDocument, type MemoryDocument } from "~/lib/memory-document";
import { useHighlighted } from "~/lib/use-highlighted";

/**
 * The user's Memory Document, shown and never editable.
 *
 * Read-only is the design, not a stage before an editor. Memory is what the system concluded; an
 * editable copy would be a second set of Custom instructions without that field's guarantees.
 * Disagreeing with a line is a thing you say in chat, which leaves a revision and a writer behind
 * it — an inline edit would leave neither.
 *
 * The route is ungated, so the panel is normally always present — empty before anything has been
 * written. It renders nothing at all only when the request fails, because a broken box on a
 * settings page reads as "your memory is gone" when the truth is "we could not fetch it".
 */
export function MemoryDocumentPanel() {
  const [state, setState] = useState<MemoryDocument | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getMemoryDocument()
      .then((doc) => {
        if (!cancelled) setState(doc);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const body = state?.document.trim() ? state.document : null;
  const html = useHighlighted(body, "markdown");

  if (failed) return null;

  return (
    <Panel
      title="Memory"
      description="What assistants have learned about you, kept as one page. The system writes it, not you, say so in chat if something here is wrong."
      footer={
        state ? (
          <span className="text-xs text-muted-foreground">
            {state.characters.toLocaleString()} / {state.characterBudget.toLocaleString()}{" "}
            characters
            {state.updatedAt
              ? ` · updated ${new Date(state.updatedAt).toLocaleDateString()}`
              : null}
          </span>
        ) : null
      }
    >
      {state === null ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : body === null ? (
        <p className="text-sm text-muted-foreground">
          Nothing yet. Memory fills in as you use TulipFarm.
        </p>
      ) : (
        <section
          aria-label="Memory document"
          className="max-h-96 overflow-auto rounded-sm border border-border text-sm"
        >
          {html ? (
            <div
              className="[&_pre]:p-4"
              // biome-ignore lint/security/noDangerouslySetInnerHtml: Shiki output is HTML-escaped, and the source is the caller's own document.
              dangerouslySetInnerHTML={{ __html: html }}
            />
          ) : (
            <pre className="whitespace-pre-wrap p-4 font-mono text-sm">{body}</pre>
          )}
        </section>
      )}
    </Panel>
  );
}
