import { useLoaderData, useRevalidator, useRouteError } from "@remix-run/react";
import { Check, Plus, Trash2, X } from "lucide-react";
import { useState } from "react";
import { FormStatus } from "~/components/form-status";
import { ErrorState } from "~/components/states";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { ConfirmModal } from "~/components/ui/modal";
import { Panel, PanelEmpty } from "~/components/ui/panel";
import { Textarea } from "~/components/ui/textarea";
import { ApiError } from "~/lib/api";
import {
  deleteMemoryEntry,
  listMemory,
  listPendingMemory,
  type PendingMemory,
  resolvePendingMemory,
  updateMemoryEntry,
} from "~/lib/memory";
import {
  getCustomInstructions,
  MAX_CUSTOM_INSTRUCTIONS_CHARS,
  putCustomInstructions,
} from "~/lib/settings";
import { cn } from "~/lib/utils";

// Suggested preference keys, each with an example value shown as the placeholder.
const PRESETS: { key: string; example: string }[] = [
  { key: "language", example: "English" },
  { key: "verbosity", example: "concise" },
  { key: "tone", example: "friendly and direct" },
  { key: "timezone", example: "America/Los_Angeles" },
  { key: "profile", example: "Staff engineer; prefers code-first answers" },
];

export async function clientLoader() {
  // Both extras are optional: a deployment with extraction turned off does not register the pending
  // route, and an empty section is the right way to render that — not a failed page.
  const [memory, pending, instructions] = await Promise.all([
    listMemory(),
    listPendingMemory().catch(() => [] as PendingMemory[]),
    getCustomInstructions().catch(() => ""),
  ]);
  return { ...memory, pending, instructions };
}

function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 422) return err.message || "That is too long — shorten it and try again.";
    if (err.status === 404) return "That entry no longer exists — refresh the page.";
    return err.message;
  }
  return err instanceof Error ? err.message : "Request failed.";
}

export default function SettingsMemory() {
  const { entries, maxValueChars, pending, instructions } = useLoaderData<typeof clientLoader>();

  return (
    <div className="space-y-6">
      <InstructionsPanel saved={instructions} />
      {pending.length > 0 ? <SuggestedPanel pending={pending} /> : null}
      <SavedMemoryPanel entries={entries} maxValueChars={maxValueChars} />
    </div>
  );
}

/**
 * Standing instructions the participant writes themselves.
 *
 * Deliberately separate from saved memory below: these are authored and permanent, while memory is
 * observed and revisable. Conflating them was the old page's core problem — it offered only the
 * assistant's guesses and no way to simply state a preference.
 */
function InstructionsPanel({ saved }: { saved: string }) {
  const revalidator = useRevalidator();
  const [value, setValue] = useState(saved);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const dirty = value !== saved;
  const over = value.length > MAX_CUSTOM_INSTRUCTIONS_CHARS;

  async function save() {
    setBusy(true);
    setError(null);
    setDone(false);
    try {
      await putCustomInstructions(value);
      setDone(true);
      revalidator.revalidate();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel
      title="Custom instructions"
      description="Standing guidance for every assistant you talk to. Written by you, applied to every conversation."
      footer={
        <>
          <span
            className={cn(
              "text-xs tabular-nums",
              over ? "text-destructive" : "text-muted-foreground"
            )}
          >
            {value.length}/{MAX_CUSTOM_INSTRUCTIONS_CHARS}
          </span>
          <div className="flex items-center gap-2">
            {dirty ? (
              <Button variant="ghost" size="sm" onClick={() => setValue(saved)} disabled={busy}>
                Cancel
              </Button>
            ) : null}
            <Button size="sm" onClick={() => void save()} disabled={busy || !dirty || over}>
              {busy ? "Saving…" : "Save"}
            </Button>
          </div>
        </>
      }
    >
      <div className="space-y-3">
        {error ? <FormStatus tone="error">{error}</FormStatus> : null}
        {done && !dirty ? <FormStatus tone="success">Instructions updated.</FormStatus> : null}
        <Textarea
          value={value}
          onChange={(e) => setValue(e.target.value)}
          rows={6}
          aria-label="Custom instructions"
          aria-invalid={over || undefined}
          placeholder={
            "Anything an assistant should always know or always do. For example:\n\n" +
            "I run a two-person landscaping business in Portland. Invoices go out on the 1st.\n" +
            "Answer in plain language and skip the preamble."
          }
        />
      </div>
    </Panel>
  );
}

/**
 * The confirmation gate. Nothing here is remembered yet — that is the whole point of the section,
 * so it sits above the saved list rather than below it.
 */
function SuggestedPanel({ pending }: { pending: PendingMemory[] }) {
  const revalidator = useRevalidator();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function resolve(id: string, decision: "confirm" | "deny") {
    setBusy(true);
    setError(null);
    try {
      await resolvePendingMemory(id, decision);
      revalidator.revalidate();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel
      title="Suggested memories"
      description="Noticed while chatting. Not remembered until you keep them."
      className="border-primary/40"
      flush
    >
      {error ? (
        <FormStatus tone="error" className="m-4 mb-0">
          {error}
        </FormStatus>
      ) : null}
      <ul>
        {pending.map((item) => (
          <li
            key={item.pendingId}
            className="flex items-center gap-3 border-b border-border px-4 py-3 last:border-b-0"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-foreground">{item.subject}</p>
              <p className="truncate text-sm text-muted-foreground">{item.statement}</p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="shrink-0 text-muted-foreground hover:text-destructive"
              disabled={busy}
              aria-label={`Discard suggested memory: ${item.subject}`}
              onClick={() => void resolve(item.pendingId, "deny")}
            >
              <X aria-hidden /> Discard
            </Button>
            <Button
              size="sm"
              className="shrink-0"
              disabled={busy}
              aria-label={`Keep suggested memory: ${item.subject}`}
              onClick={() => void resolve(item.pendingId, "confirm")}
            >
              <Check aria-hidden /> Keep
            </Button>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function SavedMemoryPanel({
  entries,
  maxValueChars,
}: {
  entries: { key: string; value: string; writtenByAgentId: string | null }[];
  maxValueChars: number;
}) {
  const revalidator = useRevalidator();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");
  const [newPlaceholder, setNewPlaceholder] = useState("");

  const newKeyTrimmed = newKey.trim();
  const newOver = newValue.length > maxValueChars;
  // Keys are unique per user — block re-adding one that exists and drop set keys from suggestions.
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
    <Panel
      title="Saved memories"
      description="Facts assistants keep about you. Edit a value or forget it entirely — you have the last word."
    >
      <div className="space-y-3">
        {error ? <FormStatus tone="error">{error}</FormStatus> : null}

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

        <div className="overflow-hidden rounded-md border border-border">
          <form
            className="flex items-center gap-2 border-b border-border bg-muted/30 px-3 py-2"
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
            <Input
              className={cn("h-8 w-28 shrink-0 sm:w-40", dupKey && "border-destructive")}
              value={newKey}
              disabled={busy}
              onChange={(e) => setNewKey(e.target.value)}
              placeholder="key"
              aria-label="New memory key"
              aria-invalid={dupKey || undefined}
            />
            <Input
              className={cn("h-8 min-w-0 flex-1", newOver && "border-destructive")}
              value={newValue}
              disabled={busy}
              onChange={(e) => setNewValue(e.target.value)}
              placeholder={newPlaceholder || "What should the assistant remember?"}
              aria-label="New memory value"
              aria-invalid={newOver || undefined}
            />
            <span
              className={cn(
                "w-14 shrink-0 text-right text-xs tabular-nums",
                newOver ? "text-destructive" : "text-muted-foreground"
              )}
            >
              {newValue.length}/{maxValueChars}
            </span>
            <Button type="submit" size="sm" className="shrink-0" disabled={!canSet}>
              <Plus aria-hidden /> Set
            </Button>
          </form>

          {entries.length === 0 ? (
            <PanelEmpty>
              Nothing saved yet — add one above, or let an assistant save them as you chat.
            </PanelEmpty>
          ) : (
            <ul>
              {entries.map((entry) => {
                const value = drafts[entry.key] ?? entry.value;
                const dirty = value !== entry.value;
                const over = value.length > maxValueChars;
                return (
                  <li
                    key={entry.key}
                    className="flex items-center gap-2 border-b border-border px-3 py-2 last:border-b-0"
                  >
                    <span
                      className="w-28 shrink-0 truncate text-sm font-medium text-foreground sm:w-40"
                      title={entry.key}
                    >
                      {entry.key}
                    </span>
                    <Input
                      className={cn("h-8 min-w-0 flex-1", over && "border-destructive")}
                      value={value}
                      disabled={busy}
                      onChange={(e) =>
                        setDrafts((prev) => ({ ...prev, [entry.key]: e.target.value }))
                      }
                      aria-label={`Value for ${entry.key}`}
                      aria-invalid={over || undefined}
                    />
                    <span
                      className={cn(
                        "w-14 shrink-0 text-right text-xs tabular-nums",
                        over ? "text-destructive" : "text-muted-foreground"
                      )}
                    >
                      {value.length}/{maxValueChars}
                    </span>
                    {dirty ? (
                      <>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="shrink-0"
                          disabled={busy}
                          onClick={() => clearDraft(entry.key)}
                        >
                          Cancel
                        </Button>
                        <Button
                          size="sm"
                          className="shrink-0"
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
                      variant="ghost"
                      size="icon"
                      className="size-8 shrink-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
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
          )}
        </div>

        {dupKey ? (
          <p className="text-xs text-destructive">
            “{newKeyTrimmed}” already exists — edit it in the list instead.
          </p>
        ) : null}
      </div>

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
    </Panel>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const status = error instanceof ApiError ? error.status : undefined;
  const message = error instanceof Error ? error.message : undefined;
  return <ErrorState section="settings" status={status} message={message} />;
}
