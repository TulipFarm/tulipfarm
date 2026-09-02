import { ArrowUp } from "lucide-react";
import { lazy, Suspense, useState } from "react";
import type { ComposerProps } from "./composer-editor";
import { DEFAULT_CHAT_MODEL_SELECTOR } from "./model-selector";

export type { ComposerAgent, ComposerProps, ComposerSendOptions } from "./composer-editor";

/*
 * Tiptap and its ProseMirror core are 119KB gzipped — the largest chunk in the app, and on the
 * landing route's critical path only because the composer sits there. In SPA mode a route's
 * clientLoader lives inside its module, so that weight was delaying the first API call of a cold
 * load by hundreds of milliseconds, for an editor nobody had typed into yet.
 */
const ComposerEditor = lazy(() =>
  import("./composer-editor").then((m) => ({ default: m.ComposerEditor }))
);

export function Composer(props: ComposerProps) {
  // Seeded from `initialDraft` so a `?draft=` link shows its text immediately, and handed back on
  // swap so anything typed before the editor arrived survives it. Passing `props.initialDraft`
  // through instead would discard whatever was typed while the chunk was in flight.
  const [draft, setDraft] = useState(props.initialDraft ?? "");

  const sendPlain = (text: string) => {
    setDraft("");
    props.onSend(text, {
      model: props.defaultModel ?? DEFAULT_CHAT_MODEL_SELECTOR,
      skills: [],
      resources: [],
      knowledgePages: [],
      files: [],
    });
  };

  return (
    <Suspense
      fallback={
        <ComposerFallback
          busy={props.busy}
          draft={draft}
          onDraftChange={setDraft}
          onSend={sendPlain}
        />
      }
    >
      <ComposerEditor {...props} initialDraft={draft || undefined} />
    </Suspense>
  );
}

/**
 * A plain-text stand-in that can compose and send a turn on its own. It deliberately drops the
 * rich-text affordances (mentions, attachments, formatting) rather than disabling them: a message
 * with none of those is the common case, and the alternative is an inert box during the only moment
 * the reader is certain to be looking at it.
 */
function ComposerFallback({
  busy,
  draft,
  onDraftChange,
  onSend,
}: {
  busy?: boolean;
  draft: string;
  onDraftChange: (value: string) => void;
  onSend: (text: string) => void;
}) {
  const trimmed = draft.trim();
  const submit = () => {
    if (!trimmed || busy) return;
    onSend(trimmed);
  };

  return (
    <div className="shrink-0 border-t border-border/70 bg-background">
      <div className="mx-auto w-full max-w-4xl px-4 pb-4 pt-2 sm:px-6">
        <div className="mb-1.5 flex min-h-8 items-center gap-2 px-1" />
        <div className="overflow-hidden rounded-lg border border-input bg-card transition-[border-color,box-shadow] focus-within:border-primary focus-within:ring-[3px] focus-within:ring-ring/15">
          <textarea
            aria-label="Message"
            className="max-h-48 min-h-[3.25rem] w-full resize-none bg-transparent px-3 py-3 text-sm outline-none placeholder:text-muted-foreground"
            onChange={(event) => onDraftChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.shiftKey) return;
              event.preventDefault();
              submit();
            }}
            placeholder="Ask anything"
            rows={2}
            value={draft}
          />
          <div className="flex items-center gap-1 px-2 pb-2 pt-0.5">
            <span className="ml-auto inline-flex">
              <button
                aria-label="Send prompt"
                className="inline-flex size-11 items-center justify-center rounded-full bg-primary text-primary-foreground transition hover:bg-primary/90 active:scale-95 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/30 disabled:opacity-35 sm:size-9"
                disabled={!trimmed || busy}
                onClick={submit}
                type="button"
              >
                <ArrowUp aria-hidden className="size-4" strokeWidth={2.25} />
              </button>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
