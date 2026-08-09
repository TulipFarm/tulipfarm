import { useLoaderData, useRevalidator, useRouteError } from "@remix-run/react";
import { Check, Plus, Trash2, X } from "lucide-react";
import { useState } from "react";
import { ErrorState } from "~/components/states";
import { Button } from "~/components/ui/button";
import { ConfirmModal } from "~/components/ui/modal";
import { ApiError } from "~/lib/api";
import {
  deleteMemoryEntry,
  listMemory,
  listPendingMemory,
  type PendingMemory,
  resolvePendingMemory,
  updateMemoryEntry,
} from "~/lib/memory";
import { cn } from "~/lib/utils";

const fieldClass =
  "rounded-sm border border-border bg-background px-3 py-1.5 text-sm outline-none transition-colors focus-visible:border-primary focus-visible:ring-[3px] focus-visible:ring-ring/30 disabled:opacity-60";

// Suggested preference keys, each with an example value shown as the placeholder.
const PRESETS: { key: string; example: string }[] = [
  { key: "language", example: "English" },
  { key: "verbosity", example: "concise" },
  { key: "tone", example: "friendly and direct" },
  { key: "timezone", example: "America/Los_Angeles" },
  { key: "profile", example: "Staff engineer; prefers code-first answers" },
];

export async function clientLoader() {
  // The queue is optional: a deployment with extraction turned off does not register the route,
  // and an empty review section is the right way to render that — not a failed page.
  const [memory, pending] = await Promise.all([
    listMemory(),
    listPendingMemory().catch(() => [] as PendingMemory[]),
  ]);
  return { ...memory, pending };
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
  const { entries, maxValueChars, pending } = useLoaderData<typeof clientLoader>();
  const revalidator = useRevalidator();

  // Per-key draft edits. Absent key → show the saved value (loader is the source of truth).
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  // Inline "add" row — a new key + value the user authors.
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
    <div className="flex flex-col gap-4">
      {error ? (
        <p
          role="alert"
          className="rounded-sm border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </p>
      ) : null}

      {/* The confirmation gate. Nothing here is remembered yet — that is the entire point of the
          section, so it sits above the saved list rather than below it. */}
      {pending.length > 0 ? (
        <section className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between">
            <h2 className="text-sm font-medium text-foreground">
              Suggested memories
              <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                ({pending.length})
              </span>
            </h2>
            <p className="text-xs text-muted-foreground">
              Noticed while chatting. Not remembered until you keep them.
            </p>
          </div>
          <ul className="flex flex-col divide-y divide-border rounded-sm border border-primary/40 bg-primary/[0.03]">
            {pending.map((item) => (
              <li key={item.pendingId} className="flex items-center gap-2.5 px-3 py-2">
                <span
                  className="w-28 shrink-0 truncate text-sm font-medium text-foreground sm:w-40"
                  title={item.subject}
                >
                  {item.subject}
                </span>
                <span
                  className="min-w-0 flex-1 truncate text-sm text-foreground"
                  title={item.statement}
                >
                  {item.statement}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="shrink-0 cursor-pointer text-muted-foreground hover:text-destructive"
                  disabled={busy}
                  aria-label={`Discard suggested memory: ${item.subject}`}
                  onClick={() => void run(() => resolvePendingMemory(item.pendingId, "deny"))}
                >
                  <X aria-hidden /> Discard
                </Button>
                <Button
                  type="button"
                  size="sm"
                  className="shrink-0 cursor-pointer"
                  disabled={busy}
                  aria-label={`Keep suggested memory: ${item.subject}`}
                  onClick={() => void run(() => resolvePendingMemory(item.pendingId, "confirm"))}
                >
                  <Check aria-hidden /> Keep
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* One-tap suggestions fill the key field of the add row below. */}
      {availablePresets.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-xs text-muted-foreground">Try</span>
          {availablePresets.map((preset) => (
            <button
              key={preset.key}
              type="button"
              disabled={busy}
              aria-pressed={newKeyTrimmed === preset.key}
              className={cn(
                "cursor-pointer rounded-sm border px-2 py-0.5 text-xs transition-colors disabled:opacity-60",
                newKeyTrimmed === preset.key
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
          ))}
        </div>
      ) : null}

      {/* One unified list: an inline add row on top, then every saved memory — each a single line. */}
      <ul className="flex flex-col divide-y divide-border rounded-sm border border-border">
        <li className="bg-muted/30">
          <form
            className="flex items-center gap-2.5 px-3 py-2"
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
            <input
              className={cn(
                fieldClass,
                "w-28 shrink-0 sm:w-40",
                dupKey && "border-destructive focus-visible:border-destructive"
              )}
              value={newKey}
              disabled={busy}
              onChange={(e) => setNewKey(e.target.value)}
              placeholder="key"
              aria-label="new memory key"
            />
            <input
              className={cn(
                fieldClass,
                "min-w-0 flex-1",
                newOver && "border-destructive focus-visible:border-destructive"
              )}
              value={newValue}
              disabled={busy}
              onChange={(e) => setNewValue(e.target.value)}
              placeholder={newPlaceholder || "value — what should the assistant remember?"}
              aria-label="new memory value"
            />
            <span
              className={cn(
                "w-14 shrink-0 text-right text-xs tabular-nums",
                newOver ? "text-destructive" : "text-muted-foreground/70"
              )}
            >
              {newValue.length}/{maxValueChars}
            </span>
            <Button type="submit" size="sm" className="shrink-0 cursor-pointer" disabled={!canSet}>
              <Plus aria-hidden /> Set
            </Button>
          </form>
        </li>

        {entries.map((entry) => {
          const value = drafts[entry.key] ?? entry.value;
          const dirty = value !== entry.value;
          const over = value.length > maxValueChars;
          const bySelf = !entry.writtenByAgentId;
          return (
            <li key={entry.key} className="flex items-center gap-2.5 px-3 py-2">
              <div className="flex w-28 shrink-0 items-center gap-1.5 sm:w-40">
                <span className="truncate text-sm font-medium text-foreground" title={entry.key}>
                  {entry.key}
                </span>
                <span
                  className="shrink-0 rounded-sm border border-border px-1 py-px text-[10px] uppercase tracking-[0.12em] text-muted-foreground"
                  title={bySelf ? "set by you" : "saved by the assistant"}
                >
                  {entry.writtenByAgentId ?? "you"}
                </span>
              </div>
              <input
                className={cn(
                  fieldClass,
                  "min-w-0 flex-1",
                  over && "border-destructive focus-visible:border-destructive"
                )}
                value={value}
                disabled={busy}
                onChange={(e) => setDrafts((prev) => ({ ...prev, [entry.key]: e.target.value }))}
                aria-label={`value for ${entry.key}`}
              />
              <span
                className={cn(
                  "w-14 shrink-0 text-right text-xs tabular-nums",
                  over ? "text-destructive" : "text-muted-foreground/70"
                )}
              >
                {value.length}/{maxValueChars}
              </span>
              {dirty ? (
                <>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="shrink-0 cursor-pointer"
                    disabled={busy}
                    onClick={() => clearDraft(entry.key)}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    className="shrink-0 cursor-pointer"
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
                </>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-8 shrink-0 cursor-pointer text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                disabled={busy}
                aria-label={`Delete ${entry.key}`}
                onClick={() => setPendingDelete(entry.key)}
              >
                <Trash2 aria-hidden />
              </Button>
            </li>
          );
        })}
      </ul>

      {dupKey ? (
        <p className="text-xs text-destructive">
          “{newKeyTrimmed}” already exists — edit it in the list instead.
        </p>
      ) : entries.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No saved memories yet — add one above, or the assistant saves them as you chat.
        </p>
      ) : null}

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
