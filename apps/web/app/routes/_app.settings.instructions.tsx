import { useLoaderData, useRevalidator, useRouteError } from "@remix-run/react";
import { useState } from "react";
import { FormStatus } from "~/components/form-status";
import { ErrorState } from "~/components/states";
import { Button } from "~/components/ui/button";
import { Panel } from "~/components/ui/panel";
import { Textarea } from "~/components/ui/textarea";
import { ApiError } from "~/lib/api";
import {
  getCustomInstructions,
  MAX_CUSTOM_INSTRUCTIONS_CHARS,
  putCustomInstructions,
} from "~/lib/settings";
import { cn } from "~/lib/utils";

export async function clientLoader() {
  return { instructions: await getCustomInstructions().catch(() => "") };
}

function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 422)
      return err.message || "That is too long \u2014 shorten it and try again.";
    return err.message;
  }
  return err instanceof Error ? err.message : "Request failed.";
}

export default function SettingsInstructions() {
  const { instructions } = useLoaderData<typeof clientLoader>();
  return <InstructionsPanel saved={instructions} />;
}

/**
 * Custom instructions are the only part of what an Agent knows about you that you author.
 *
 * Memory is deliberately absent from this page: it is one Markdown document the system maintains,
 * not a list of facts to curate, and it is neither shown nor editable here. A pane that let you
 * approve or delete entries would describe a store this product no longer has.
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

export function ErrorBoundary() {
  const error = useRouteError();
  const status = error instanceof ApiError ? error.status : undefined;
  const message = error instanceof Error ? error.message : undefined;
  return <ErrorState section="settings" status={status} message={message} />;
}
