import { useNavigate } from "@remix-run/react";
import { ArrowRight, MessageCircle, X } from "lucide-react";
import { useState } from "react";
import { ApiError } from "~/lib/api";
import type { Quest } from "~/lib/onboarding";
import { answerQuest } from "~/lib/onboarding";

const TIER_LABEL: Record<Quest["tier"], string> = {
  1: "Get set up",
  2: "Build your system",
  3: "Tell us more",
};

/** Inline form for a tier-1 `form` quest — answers land in soul.yaml, no chat round-trip. */
function FormQuest({ quest, onAnswered }: { quest: Quest; onAnswered: () => void }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = value.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      await answerQuest(quest.id, trimmed);
      onAnswered();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save that — try again.");
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-1.5">
      <label htmlFor={`quest-${quest.id}`} className="text-sm font-medium text-foreground">
        {quest.label}
      </label>
      {quest.hint ? <p className="text-xs text-muted-foreground">{quest.hint}</p> : null}
      <div className="flex gap-1.5">
        <input
          id={`quest-${quest.id}`}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          disabled={busy}
          className="h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-2.5 text-sm text-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/25"
        />
        <button
          type="submit"
          disabled={busy || !value.trim()}
          className="inline-flex h-9 shrink-0 items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 disabled:opacity-40"
        >
          Save
        </button>
      </div>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </form>
  );
}

function QuestRow({
  quest,
  onDismiss,
  onAnswered,
  onClose,
}: {
  quest: Quest;
  onDismiss: (id: string) => void;
  onAnswered: () => void;
  onClose: () => void;
}) {
  const navigate = useNavigate();

  return (
    <li className="flex items-start gap-2 rounded-md border border-border bg-background p-3">
      <div className="min-w-0 flex-1">
        {quest.action.kind === "form" ? (
          <FormQuest quest={quest} onAnswered={onAnswered} />
        ) : (
          <>
            <p className="text-sm font-medium text-foreground">{quest.label}</p>
            {quest.hint ? (
              <p className="mt-0.5 text-xs text-muted-foreground">{quest.hint}</p>
            ) : null}
            <button
              type="button"
              onClick={() => {
                const action = quest.action;
                if (action.kind === "link") {
                  navigate(action.href);
                } else if (action.kind === "chat") {
                  navigate(`/?draft=${encodeURIComponent(action.prompt)}`);
                }
                onClose();
              }}
              className="mt-2 inline-flex h-8 items-center gap-1.5 rounded-md border border-input bg-background px-2.5 text-xs font-medium text-muted-foreground transition hover:border-primary/60 hover:bg-accent hover:text-foreground active:translate-y-px"
            >
              {quest.action.kind === "chat" ? (
                <MessageCircle className="size-3.5 text-primary" aria-hidden />
              ) : (
                <ArrowRight className="size-3.5 text-primary" aria-hidden />
              )}
              {quest.action.kind === "chat" ? "Ask in chat" : "Go"}
            </button>
          </>
        )}
      </div>
      <button
        type="button"
        onClick={() => onDismiss(quest.id)}
        aria-label={`Dismiss "${quest.label}"`}
        className="-mr-1 -mt-1 inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-accent hover:text-foreground"
      >
        <X className="size-3.5" aria-hidden />
      </button>
    </li>
  );
}

export function CompanionPanel({
  quests,
  loading,
  onDismiss,
  onAnswered,
  onClose,
}: {
  quests: Quest[];
  loading: boolean;
  onDismiss: (id: string) => void;
  onAnswered: () => void;
  onClose: () => void;
}) {
  if (loading && quests.length === 0) {
    return <p className="p-4 text-sm text-muted-foreground">Loading…</p>;
  }
  if (quests.length === 0) {
    return <p className="p-4 text-sm text-muted-foreground">You're all caught up.</p>;
  }

  const groups = new Map<Quest["tier"], Quest[]>();
  for (const quest of quests) {
    const list = groups.get(quest.tier) ?? [];
    list.push(quest);
    groups.set(quest.tier, list);
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      {[...groups.entries()].map(([tier, tierQuests]) => (
        <section key={tier}>
          <p className="mb-2 text-xs font-medium text-muted-foreground">{TIER_LABEL[tier]}</p>
          <ul className="flex flex-col gap-2">
            {tierQuests.map((quest) => (
              <QuestRow
                key={quest.id}
                quest={quest}
                onDismiss={onDismiss}
                onAnswered={onAnswered}
                onClose={onClose}
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
