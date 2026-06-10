import type * as React from "react";
import { useEffect, useRef, useState } from "react";
import type { ModelTier } from "~/lib/chat/types";
import { ModelSelector } from "./model-selector";

const PLACEHOLDERS = [
  "Ask anything…",
  "what can you do?",
  "summarize my open approvals",
  "draft a reply to the latest lead",
];

const MAX_TEXTAREA_PX = 180;

/**
 * Message composer: an auto-growing textarea over a control row (model override + send). There is
 * deliberately NO attachment/upload affordance (no blob storage in V1). Enter sends; Shift+Enter
 * adds a newline. The model tier defaults to the active agent's (`defaultModel`) and is emitted with
 * each send so the turn carries it.
 */
export function Composer({
  onSend,
  busy,
  defaultModel = "standard",
}: {
  onSend: (text: string, opts: { model: ModelTier }) => void;
  busy?: boolean;
  defaultModel?: ModelTier;
}) {
  const [text, setText] = useState("");
  const [model, setModel] = useState<ModelTier>(defaultModel);
  const [placeholder, setPlaceholder] = useState(PLACEHOLDERS[0]);
  const ref = useRef<HTMLTextAreaElement>(null);

  // Cycle the placeholder while the field is empty; pause once the user starts typing.
  useEffect(() => {
    if (text) return;
    let i = 0;
    const id = setInterval(() => {
      i = (i + 1) % PLACEHOLDERS.length;
      setPlaceholder(PLACEHOLDERS[i]);
    }, 3500);
    return () => clearInterval(id);
  }, [text]);

  // Grow the textarea to fit its content, up to a cap (then it scrolls).
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure on every text change
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_PX)}px`;
  }, [text]);

  function submit() {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    onSend(trimmed, { model });
    setText("");
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  return (
    <div className="shrink-0 border-t border-border bg-background">
      <div className="mx-auto w-full max-w-3xl px-6 py-3">
        <div className="overflow-hidden rounded-sm border border-input bg-secondary transition-colors focus-within:border-primary">
          <textarea
            ref={ref}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            rows={1}
            placeholder={placeholder}
            aria-label="Message"
            className="block w-full resize-none bg-transparent px-3.5 py-3 text-sm leading-relaxed text-foreground outline-none placeholder:text-muted-foreground"
          />
          <div className="flex items-center gap-4 border-t border-border/60 px-3 py-2">
            <ModelSelector value={model} onChange={setModel} disabled={busy} />
            <button
              type="button"
              onClick={submit}
              disabled={!text.trim() || busy}
              className="ml-auto inline-flex items-center gap-1.5 rounded-sm bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-40"
            >
              send
              <span aria-hidden className="opacity-70">
                ↵
              </span>
            </button>
          </div>
        </div>
        <p className="mt-1.5 px-1 text-[0.625rem] text-muted-foreground">
          enter to send · shift+enter for newline
        </p>
      </div>
    </div>
  );
}
