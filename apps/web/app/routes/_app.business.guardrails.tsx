import { useLoaderData, useRevalidator, useRouteError } from "@remix-run/react";
import { useState } from "react";
import { FormStatus } from "~/components/form-status";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Panel, PanelEmpty } from "~/components/ui/panel";
import { getGuardrails, proposeGuardrailToggle } from "~/lib/admin";
import { ApiError } from "~/lib/api";
import { shortRevision } from "~/lib/utils";

export async function clientLoader() {
  return { model: await getGuardrails() };
}

export default function BusinessGuardrails() {
  const { model } = useLoaderData<typeof clientLoader>();
  const revalidator = useRevalidator();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string | null>(null);

  async function toggle(item: (typeof model.items)[number]) {
    setBusy(item.id);
    setError(null);
    try {
      await proposeGuardrailToggle(model, item, item.enabled === false);
      revalidator.revalidate();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not reach the API.");
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <div className="space-y-4">
      {error ? <FormStatus tone="error">{error}</FormStatus> : null}
      <Panel
        title="Guardrails"
        description={`Turning one on or off is a Soul changeset, so it may need approval before it takes effect. Revision ${shortRevision(model.revision)}.`}
        flush
      >
        {model.items.length === 0 ? (
          <PanelEmpty>No guardrails configured.</PanelEmpty>
        ) : (
          <ul>
            {model.items.map((item) => {
              const off = item.enabled === false;
              return (
                <li
                  key={item.id}
                  className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3 last:border-b-0"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground">
                      {item.name ?? item.id}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {item.effect ?? "configured"} · applies to {item.scope ?? "everything"}
                    </p>
                  </div>
                  <Badge variant={off ? "neutral" : "success"}>{off ? "Off" : "On"}</Badge>
                  <Button
                    variant="outline"
                    size="sm"
                    className="shrink-0"
                    disabled={busy === item.id}
                    onClick={() => void toggle(item)}
                  >
                    {busy === item.id ? "Proposing…" : off ? "Turn on" : "Turn off"}
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
    </div>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const message =
    error instanceof ApiError
      ? error.status === 403
        ? "You do not have permission to change guardrails."
        : error.message
      : "Could not load guardrails.";
  return <FormStatus tone="error">{message}</FormStatus>;
}
