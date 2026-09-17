import { useLoaderData, useRevalidator, useRouteError } from "@remix-run/react";
import { useState } from "react";
import { FormStatus } from "~/components/form-status";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Link } from "~/components/ui/link";
import { Panel, PanelEmpty } from "~/components/ui/panel";
import { type GuardrailItem, getGuardrails, proposeGuardrailToggle } from "~/lib/admin";
import { ApiError } from "~/lib/api";
import { shortRevision } from "~/lib/utils";

/**
 * A Guardrail is authored by an agent through `guardrail_forge`, so the create control drafts the
 * request into the chat composer rather than posting a policy this screen would have to compose.
 */
const ADD_GUARDRAIL_DRAFT =
  "Add a guardrail. Ask me what it should limit: blocking a tool by name, filtering sensitive " +
  "content out of replies, or screening prompt injection, then create it.";

const PATTERN_LABELS: Record<string, string> = {
  credit_card: "Credit card numbers",
  ssn: "Social Security numbers",
  api_key: "API keys",
  email: "Email addresses",
};

function policyDetails(item: GuardrailItem): string[] {
  const patterns = item.policy.patterns;
  if (Array.isArray(patterns)) {
    return patterns.flatMap((pattern) =>
      typeof pattern === "string" ? [PATTERN_LABELS[pattern] ?? pattern] : []
    );
  }
  const block = item.policy.block;
  if (Array.isArray(block)) {
    return block.flatMap((name) => (typeof name === "string" ? [`Blocks ${name}`] : []));
  }
  const sensitivity = item.policy.sensitivity;
  return typeof sensitivity === "string" ? [`${sensitivity} sensitivity`] : [];
}

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
        description={`${model.source === "default" ? "Built-in defaults are active." : "Custom Soul policy is active."} Revision ${shortRevision(model.revision)}.`}
        actions={
          <Button asChild size="sm">
            <Link to={`/?draft=${encodeURIComponent(ADD_GUARDRAIL_DRAFT)}`}>Add guardrail</Link>
          </Button>
        }
        flush
      >
        {model.items.length === 0 ? (
          <PanelEmpty>The custom Soul policy has no active guardrails.</PanelEmpty>
        ) : (
          <ul>
            {model.items.map((item) => {
              const off = item.enabled === false;
              const details = policyDetails(item);
              return (
                <li
                  key={item.id}
                  className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3 last:border-b-0"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground">
                      {item.name ?? item.id}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {item.effect ?? "Configured"} · applies to {item.scope}
                    </p>
                    {details.length > 0 ? (
                      <ul className="mt-1 flex flex-wrap gap-1" aria-label={`${item.name} rules`}>
                        {details.map((detail) => (
                          <li key={detail}>
                            <Badge variant="neutral">{detail}</Badge>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                  <Badge variant={off ? "neutral" : "success"}>{off ? "Off" : "On"}</Badge>
                  <Badge variant="neutral">{item.source === "default" ? "Built-in" : "Soul"}</Badge>
                  {item.source === "custom" ? (
                    <Button
                      variant="outline"
                      size="sm"
                      className="shrink-0"
                      disabled={busy === item.id}
                      onClick={() => void toggle(item)}
                    >
                      {busy === item.id ? "Proposing…" : off ? "Turn on" : "Turn off"}
                    </Button>
                  ) : null}
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
