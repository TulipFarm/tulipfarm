import { useEffect, useState } from "react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Link } from "~/components/ui/link";
import {
  type NativeChannelSetup,
  type NativeProvider,
  type NativeRoutineEvent,
  type NativeRoutineRouteInput,
  saveNativeRoutineRoute,
} from "~/lib/native-channels";
import { listRoutines, type RoutineSummary } from "~/lib/routines";
import { IntegrationChoice } from "./integration-choice";
import { McpError, McpField } from "./mcp-form";

const events: Record<NativeProvider, { value: NativeRoutineEvent; label: string }[]> = {
  github: [
    { value: "github.push", label: "GitHub push" },
    { value: "github.issues", label: "GitHub issue event" },
    { value: "github.pull_request", label: "GitHub pull request event" },
  ],
  slack: [
    { value: "slack.reaction_added", label: "Slack reaction added" },
    { value: "slack.reaction_removed", label: "Slack reaction removed" },
  ],
};

export function NativeRoutineRoutes({
  setup,
  onSaved,
}: {
  setup: NativeChannelSetup;
  onSaved: (setup: NativeChannelSetup) => void;
}) {
  const [routines, setRoutines] = useState<RoutineSummary[]>();
  const [draft, setDraft] = useState<NativeRoutineRouteInput>();
  const [editingId, setEditingId] = useState<string>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const [attempt, setAttempt] = useState(0);
  const [notice, setNotice] = useState("");
  const options = events[setup.provider];
  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry refreshes the current Routine directory.
  useEffect(() => {
    let live = true;
    setRoutines(undefined);
    setError(undefined);
    listRoutines()
      .then((items) => {
        if (live) setRoutines(items);
      })
      .catch((cause) => {
        if (live) setError(cause);
      });
    return () => {
      live = false;
    };
  }, [attempt]);

  const selected = routines?.find((routine) => routine.id === draft?.routineId);
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Save a disabled event first. Then approve the Routine's exact shared account and destination
        in{" "}
        <Link to="/integrations" className="underline">
          Integrations
        </Link>
        , return here and enable the event. Saving a draft does not grant account access or borrow a
        user's personal account. Material Routine changes require fresh approval.
      </p>
      <McpError error={error} />
      {!routines ? (
        error ? (
          <Button size="sm" variant="outline" onClick={() => setAttempt((value) => value + 1)}>
            Retry Routine directory
          </Button>
        ) : (
          <p role="status" className="text-xs text-muted-foreground">
            Loading Routines...
          </p>
        )
      ) : (
        <>
          <ul className="divide-y divide-border">
            {setup.routineRoutes.map((route) => (
              <li key={route.id} className="flex flex-wrap items-center gap-2 py-3">
                <div className="min-w-0 flex-1 text-xs text-muted-foreground">
                  <p className="break-all text-sm font-medium text-foreground">
                    {route.destination}
                  </p>
                  <p>
                    {options.find((option) => option.value === route.eventType)?.label ??
                      route.eventType}{" "}
                    · {route.enabled ? "Enabled" : "Disabled"}
                  </p>
                  <p className="break-all">Routine: {route.routineId}</p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={() => {
                    const event = options.find((option) => option.value === route.eventType);
                    if (!event) {
                      setError(
                        new Error("This event type is not supported by the current channel setup.")
                      );
                      return;
                    }
                    setEditingId(route.id);
                    setDraft({
                      integrationId: route.integrationId,
                      destination: route.destination,
                      eventType: event.value,
                      routineId: route.routineId,
                      enabled: route.enabled,
                    });
                    setNotice("");
                  }}
                >
                  Edit Routine event
                </Button>
              </li>
            ))}
          </ul>
          {setup.routineRoutes.length === 0 && (
            <p className="text-xs text-muted-foreground">No automated Routine events configured.</p>
          )}
          {!draft && (
            <Button
              variant="outline"
              disabled={!setup.integrations.some((integration) => integration.status === "active")}
              onClick={() => {
                setEditingId(undefined);
                setNotice("");
                setDraft({
                  integrationId: "",
                  destination: "",
                  eventType: setup.provider === "github" ? "github.push" : "slack.reaction_added",
                  routineId: "",
                  enabled: false,
                });
              }}
            >
              Add Routine event
            </Button>
          )}
          {draft && (
            <form
              className="max-w-xl space-y-3"
              onSubmit={async (event) => {
                event.preventDefault();
                setPending(true);
                setError(undefined);
                setNotice("");
                try {
                  if (
                    !editingId &&
                    setup.routineRoutes.some(
                      (route) =>
                        route.integrationId === draft.integrationId &&
                        route.destination === draft.destination.trim() &&
                        route.eventType === draft.eventType
                    )
                  )
                    throw new Error(
                      "This destination and event already have a Routine route. Edit that route instead."
                    );
                  onSaved(
                    await saveNativeRoutineRoute(setup.provider, {
                      ...draft,
                      destination: draft.destination.trim(),
                    })
                  );
                  setDraft(undefined);
                  setEditingId(undefined);
                  setNotice(
                    draft.enabled
                      ? "Routine event enabled."
                      : "Routine event saved disabled. Review its shared account grant before enabling."
                  );
                } catch (cause) {
                  setError(cause);
                } finally {
                  setPending(false);
                }
              }}
            >
              <fieldset disabled={pending} className="space-y-3">
                <McpField
                  label={setup.provider === "slack" ? "Slack workspace" : "GitHub App installation"}
                >
                  <IntegrationChoice
                    label="Routine provider account"
                    value={draft.integrationId}
                    disabled={!!editingId}
                    options={setup.integrations
                      .filter((integration) => integration.status === "active")
                      .map((integration) => ({
                        value: integration.id,
                        label: `${integration.externalTenantId} · ${integration.id}`,
                      }))}
                    onChange={(integrationId) => setDraft({ ...draft, integrationId })}
                  />
                </McpField>
                <McpField
                  label={setup.provider === "slack" ? "Slack channel ID" : "GitHub repository"}
                >
                  <Input
                    required
                    maxLength={200}
                    disabled={!!editingId}
                    pattern={
                      setup.provider === "slack"
                        ? "[CGD][A-Z0-9]+"
                        : "[a-zA-Z0-9_.\\-]+/[a-zA-Z0-9_.\\-]+"
                    }
                    value={draft.destination}
                    onChange={(event) => setDraft({ ...draft, destination: event.target.value })}
                  />
                </McpField>
                <McpField label="Provider event">
                  <IntegrationChoice
                    label="Provider event"
                    value={draft.eventType}
                    disabled={!!editingId}
                    options={options}
                    onChange={(value) => {
                      const event = options.find((option) => option.value === value);
                      if (event) setDraft({ ...draft, eventType: event.value });
                    }}
                  />
                </McpField>
                <McpField label="Routine">
                  <IntegrationChoice
                    label="Event Routine"
                    value={draft.routineId}
                    options={routines.map((routine) => ({
                      value: routine.id,
                      label: `${routine.displayName ?? routine.slug} · ${routine.slug}`,
                    }))}
                    onChange={(routineId) => setDraft({ ...draft, routineId })}
                  />
                </McpField>
                {selected && (
                  <Link
                    to={`/routines/${encodeURIComponent(selected.slug)}`}
                    className="text-xs underline"
                  >
                    Review Routine before enabling
                  </Link>
                )}
                {editingId && (
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={draft.enabled}
                      onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
                    />
                    Enable this Routine event
                  </label>
                )}
                <div className="flex gap-2">
                  <Button type="submit" disabled={!draft.integrationId || !draft.routineId}>
                    {pending
                      ? "Saving..."
                      : editingId
                        ? "Save Routine event"
                        : "Save Routine event draft"}
                  </Button>
                  <Button type="button" variant="outline" onClick={() => setDraft(undefined)}>
                    Cancel
                  </Button>
                </div>
              </fieldset>
            </form>
          )}
        </>
      )}
      {notice && (
        <p role="status" className="text-xs text-muted-foreground">
          {notice}
        </p>
      )}
    </div>
  );
}
