import { useLoaderData, useRevalidator, useRouteError } from "@remix-run/react";
import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { ErrorState } from "~/components/states";
import { Button } from "~/components/ui/button";
import { ConfirmModal } from "~/components/ui/modal";
import { ApiError } from "~/lib/api";
import { deleteMemoryEntry, listMemory, updateMemoryEntry } from "~/lib/memory";
import { cn } from "~/lib/utils";

const fieldClass =
  "w-full rounded-sm border border-border bg-background px-3 py-2 text-sm outline-none transition-colors focus-visible:border-primary focus-visible:ring-[3px] focus-visible:ring-ring/30 disabled:opacity-60";
// Auto-grow with content (modern browsers), capped — no giant empty boxes for one-line values.
const valueClass = cn(
  fieldClass,
  "field-sizing-content min-h-9 max-h-48 resize-none leading-relaxed"
);

// Suggested preference keys, each with an example value shown as the placeholder.
const PRESETS: { key: string; example: string }[] = [
  { key: "language", example: "English" },
  { key: "verbosity", example: "concise" },
  { key: "tone", example: "friendly and direct" },
  { key: "timezone", example: "America/Los_Angeles" },
  { key: "profile", example: "Staff engineer; prefers code-first answers" },
];

export async function clientLoader() {
  return listMemory();
}

function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 422) return err.message || "that's too long — shorten it and try again";
    if (err.status === 404) return "that entry no longer exists — refresh the page";
    return err.message;
  }
  return err instanceof Error ? err.message : "request failed";
}

export default function SettingsMemory() {
  const { entries, maxValueChars } = useLoaderData<typeof clientLoader>();
  const revalidator = useRevalidator();

  // Per-key textarea drafts. Absent key → show the saved value (loader is the source of truth).
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  // "Set a preference" composer — a new key + value the user authors.
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");
  const [newPlaceholder, setNewPlaceholder] = useState("");
  const newKeyTrimmed = newKey.trim();
  const newOver = newValue.length > maxValueChars;
  // Keys are unique per user — block re-adding one that exists (edit it in the list instead) and
  // drop already-set keys from the suggestions.
  const existingKeys = new Set(entries.map((e) => e.key));
  const dupKey = newKeyTrimmed.length > 0 && existingKeys.has(newKeyTrimmed);
  const availablePresets = PRESETS.filter((p) => !existingKeys.has(p.key));
  const canSet = !busy && newKeyTrimmed.length > 0 && newValue.length > 0 && !newOver && !dupKey;

  async function run(fn: () => Promise<unknown>, onOk?: () => void) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onOk?.();
      revalidator.revalidate();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  function clearDraft(key: string) {
    setDrafts((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  return (
    <div className="flex flex-col gap-8">
      <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">
        What the assistant remembers about you — facts it saved as you chat, plus preferences you
        set. These ride along on every chat so it can personalize its answers.
      </p>

      {error ? (
        <p
          role="alert"
          className="rounded-sm border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </p>
      ) : null}

      {/* Composer — a distinct, lightly-tinted input zone, set apart from the saved list. */}
      <form
        className="flex flex-col gap-4 rounded-sm border border-border bg-muted/30 p-5"
        onSubmit={(e) => {
          e.preventDefault();
          if (!canSet) return;
          void run(
            () => updateMemoryEntry(newKeyTrimmed, newValue),
            () => {
              setNewKey("");
              setNewValue("");
              setNewPlaceholder("");
            }
          );
        }}
      >
        <h2 className="text-sm font-medium text-foreground">Set a memory or preference</h2>

        {availablePresets.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-xs text-muted-foreground">Try</span>
            {availablePresets.map((preset) => {
              const active = newKeyTrimmed === preset.key;
              return (
                <button
                  key={preset.key}
                  type="button"
                  disabled={busy}
                  aria-pressed={active}
                  className={cn(
                    "cursor-pointer rounded-sm border px-2 py-0.5 text-xs transition-colors disabled:opacity-60",
                    active
                      ? "border-primary bg-primary/10 text-foreground"
                      : "border-border text-muted-foreground hover:border-primary/60 hover:text-foreground"
                  )}
                  onClick={() => {
                    setNewKey(preset.key);
                    setNewPlaceholder(preset.example);
                  }}
                >
                  {preset.key}
                </button>
              );
            })}
          </div>
        ) : null}

        <div className="flex flex-col gap-1">
          <input
            className={cn(
              fieldClass,
              dupKey && "border-destructive focus-visible:border-destructive"
            )}
            value={newKey}
            disabled={busy}
            onChange={(e) => setNewKey(e.target.value)}
            placeholder="key — e.g. tone"
            aria-label="memory key"
          />
          {dupKey ? (
            <span className="text-xs text-destructive">
              “{newKeyTrimmed}” already exists — edit it below instead
            </span>
          ) : null}
        </div>

        <textarea
          className={valueClass}
          rows={1}
          value={newValue}
          disabled={busy}
          onChange={(e) => setNewValue(e.target.value)}
          placeholder={newPlaceholder || "value — what should the assistant remember?"}
          aria-label="memory value"
        />

        <div className="flex items-center justify-end gap-3">
          {newValue.length > 0 ? (
            <span
              className={cn(
                "text-xs tabular-nums",
                newOver ? "text-destructive" : "text-muted-foreground"
              )}
            >
              {newValue.length} / {maxValueChars}
            </span>
          ) : null}
          <Button type="submit" size="sm" className="cursor-pointer" disabled={!canSet}>
            <Plus aria-hidden /> {busy ? "Saving…" : "Set"}
          </Button>
        </div>
      </form>

      {/* Saved list */}
      <section className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-medium text-foreground">Remembered</h2>
          {entries.length > 0 ? (
            <span className="text-xs tabular-nums text-muted-foreground">
              {entries.length} {entries.length === 1 ? "entry" : "entries"}
            </span>
          ) : null}
        </div>

        {entries.length === 0 ? (
          <p className="rounded-sm border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
            Nothing yet — set a preference above, or the assistant adds memory as you chat.
          </p>
        ) : (
          <ul className="flex flex-col gap-2.5">
            {entries.map((entry) => {
              const value = drafts[entry.key] ?? entry.value;
              const dirty = value !== entry.value;
              const over = value.length > maxValueChars;
              const bySelf = !entry.writtenByAgentId;
              return (
                <li
                  key={entry.key}
                  className="flex flex-col gap-2 rounded-sm border border-border p-4"
                >
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-foreground">{entry.key}</span>
                    <span
                      className="rounded-sm border border-border px-1.5 py-px text-[10px] uppercase tracking-[0.12em] text-muted-foreground"
                      title={bySelf ? "set by you" : "saved by the assistant"}
                    >
                      {entry.writtenByAgentId ?? "you"}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="ml-auto size-8 cursor-pointer text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                      disabled={busy}
                      aria-label={`Delete ${entry.key}`}
                      onClick={() => setPendingDelete(entry.key)}
                    >
                      <Trash2 aria-hidden />
                    </Button>
                  </div>

                  <textarea
                    className={valueClass}
                    rows={1}
                    value={value}
                    disabled={busy}
                    onChange={(e) =>
                      setDrafts((prev) => ({ ...prev, [entry.key]: e.target.value }))
                    }
                    aria-label={`value for ${entry.key}`}
                  />

                  {dirty ? (
                    <div className="flex items-center justify-end gap-3">
                      <span
                        className={cn(
                          "text-xs tabular-nums",
                          over ? "text-destructive" : "text-muted-foreground"
                        )}
                      >
                        {value.length} / {maxValueChars}
                      </span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="cursor-pointer"
                        disabled={busy}
                        onClick={() => clearDraft(entry.key)}
                      >
                        Cancel
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        className="cursor-pointer"
                        disabled={busy || over}
                        onClick={() =>
                          void run(
                            () => updateMemoryEntry(entry.key, value),
                            () => clearDraft(entry.key)
                          )
                        }
                      >
                        {busy ? "Saving…" : "Save"}
                      </Button>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <ConfirmModal
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        onConfirm={() => {
          const key = pendingDelete;
          setPendingDelete(null);
          if (key) {
            void run(
              () => deleteMemoryEntry(key),
              () => clearDraft(key)
            );
          }
        }}
        title="Delete memory"
        description={`Forget "${pendingDelete ?? ""}"? This cannot be undone.`}
        busy={busy}
      />
    </div>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const status = error instanceof ApiError ? error.status : undefined;
  const message = error instanceof Error ? error.message : undefined;
  return <ErrorState section="settings" status={status} message={message} />;
}
