import { useEffect, useState } from "react";
import { Button } from "~/components/ui/button";
import { CopyField } from "~/components/ui/copy-field";
import { Input } from "~/components/ui/input";
import { Link } from "~/components/ui/link";
import { type AgentSummary, listAgents } from "~/lib/agents";
import {
  getNativeChannelSetup,
  type NativeChannelRoute,
  type NativeChannelSetup,
  type NativeChannelSetupInput,
  type NativeProvider,
  saveNativeChannelSetup,
} from "~/lib/native-channels";
import { listUsers, type UserSummary } from "~/lib/users";
import { IntegrationChoice } from "./integration-choice";
import { checkedValues, McpError, McpField } from "./mcp-form";
import { NativeRoutineRoutes } from "./native-routine-routes";

function routeInput(route?: NativeChannelRoute): NativeChannelSetupInput {
  return {
    integrationId: route?.integrationId ?? "",
    routeId: route?.id ?? "",
    agentId: route?.agentId ?? "",
    channelId: route?.channelId ?? "",
    threadId: route?.threadId ?? "",
    principalIds: route?.principalIds ?? [],
    enabled: route ? route.status === "active" : true,
  };
}

export function NativeChannelRoutes({ provider }: { provider: NativeProvider }) {
  const [data, setData] = useState<{
    setup: NativeChannelSetup;
    agents: AgentSummary[];
    users: UserSummary[];
  }>();
  const [draft, setDraft] = useState<NativeChannelSetupInput>();
  const [editingId, setEditingId] = useState<string>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const [notice, setNotice] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [showRoutines, setShowRoutines] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry reloads the same native route configuration.
  useEffect(() => {
    let live = true;
    setData(undefined);
    setError(undefined);
    Promise.all([getNativeChannelSetup(provider), listAgents(), listUsers()])
      .then(([setup, agents, users]) => {
        if (live)
          setData({ setup, agents, users: users.filter((user) => user.status === "active") });
      })
      .catch((cause) => {
        if (live) setError(cause);
      });
    return () => {
      live = false;
    };
  }, [provider, attempt]);

  const unavailableUsers =
    draft?.principalIds.filter((id) => !data?.users.some((user) => user.id === id)) ?? [];

  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold">Channel routing</h3>
      <p className="text-xs text-muted-foreground">
        Choose an exact provider destination, Agent and allowed users. Users must link their
        provider identity and retain access to the Agent. Personal MCP accounts are not available in
        channels. These routes handle human messages, not automated Routine triggers.
        {provider === "slack" ? " Slack content is not synced into Knowledge." : ""}
      </p>
      <McpError error={error} />
      {!data ? (
        error ? (
          <Button size="sm" variant="outline" onClick={() => setAttempt((value) => value + 1)}>
            Retry channel routes
          </Button>
        ) : (
          <p role="status" className="text-xs text-muted-foreground">
            Loading channel routes...
          </p>
        )
      ) : (
        <>
          <div className="space-y-2">
            <p className="text-sm font-medium">Webhook URL</p>
            <CopyField value={data.setup.webhookUrl} label="webhook URL" />
          </div>
          <ul className="divide-y divide-border">
            {data.setup.routes.map((route) => (
              <li key={route.id} className="flex flex-wrap items-center gap-2 py-3">
                <div className="min-w-0 flex-1 text-xs text-muted-foreground">
                  <p className="break-all text-sm font-medium text-foreground">
                    {route.channelId ?? "No destination"}
                    {route.threadId ? ` · ${route.threadId}` : ""}
                  </p>
                  <p className="break-all">
                    Agent: {route.agentId} ·{" "}
                    {route.status !== "active"
                      ? "Disabled"
                      : route.principalIds.length > 0
                        ? "Enabled"
                        : "Action required: add user grants"}
                  </p>
                  <p className="break-all">Route: {route.id}</p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={() => {
                    setEditingId(route.id);
                    setDraft(routeInput(route));
                    setNotice("");
                  }}
                >
                  Edit route
                </Button>
              </li>
            ))}
          </ul>
          {data.setup.routes.length === 0 && (
            <p className="text-xs text-muted-foreground">
              Action required: no channel routes are configured. Connected credentials alone do not
              authorize incoming messages.
            </p>
          )}
          {!draft &&
            (data.setup.integrations.some((integration) => integration.status === "active") ? (
              <Button
                variant="outline"
                onClick={() => {
                  setEditingId(undefined);
                  setDraft(routeInput());
                  setNotice("");
                }}
              >
                Add channel route
              </Button>
            ) : (
              <p className="text-xs text-muted-foreground">
                Connect a provider workspace or GitHub App installation before adding a route.
              </p>
            ))}
          {draft && (
            <form
              className="max-w-xl space-y-3"
              onSubmit={async (event) => {
                event.preventDefault();
                setPending(true);
                setError(undefined);
                setNotice("");
                try {
                  const { threadId, ...input } = draft;
                  const setup = await saveNativeChannelSetup(provider, {
                    ...input,
                    routeId: draft.routeId.trim(),
                    channelId: draft.channelId.trim(),
                    ...(threadId?.trim() ? { threadId: threadId.trim() } : {}),
                  });
                  setData({ ...data, setup });
                  setDraft(undefined);
                  setEditingId(undefined);
                  setNotice("Channel route saved.");
                } catch (cause) {
                  setError(cause);
                } finally {
                  setPending(false);
                }
              }}
            >
              <fieldset disabled={pending} className="space-y-3">
                <McpField
                  label={provider === "slack" ? "Slack workspace" : "GitHub App installation"}
                >
                  <IntegrationChoice
                    label="Provider account"
                    value={draft.integrationId}
                    disabled={!!editingId}
                    options={data.setup.integrations
                      .filter((integration) => integration.status === "active")
                      .map((integration) => ({
                        value: integration.id,
                        label: `${integration.externalTenantId} · ${integration.id}`,
                      }))}
                    onChange={(integrationId) => setDraft({ ...draft, integrationId })}
                  />
                </McpField>
                <McpField
                  label="Route ID"
                  hint="A short local identifier. Existing route IDs stay unchanged."
                >
                  <Input
                    required
                    pattern={"[a-zA-Z0-9_\\-]{1,100}"}
                    maxLength={100}
                    disabled={!!editingId}
                    value={draft.routeId}
                    onChange={(event) => setDraft({ ...draft, routeId: event.target.value })}
                  />
                </McpField>
                <McpField label="Agent">
                  <IntegrationChoice
                    label="Channel Agent"
                    value={draft.agentId}
                    options={data.agents.map((agent) => ({
                      value: agent.name,
                      label: `${agent.label ?? agent.name} · ${agent.name}`,
                    }))}
                    onChange={(agentId) => setDraft({ ...draft, agentId })}
                  />
                </McpField>
                {data.agents.length === 0 && (
                  <Link to="/agents" className="text-xs underline">
                    Create an Agent before adding a route
                  </Link>
                )}
                <McpField
                  label={provider === "slack" ? "Slack channel ID" : "GitHub repository"}
                  hint={
                    provider === "slack"
                      ? "Use the exact provider channel ID, not its display name."
                      : "Use owner/repository."
                  }
                >
                  <Input
                    required
                    maxLength={200}
                    pattern={
                      provider === "slack"
                        ? "[CGD][A-Z0-9]+"
                        : "[a-zA-Z0-9_.\\-]+/[a-zA-Z0-9_.\\-]+"
                    }
                    value={draft.channelId}
                    onChange={(event) => setDraft({ ...draft, channelId: event.target.value })}
                  />
                </McpField>
                <McpField
                  label={
                    provider === "slack"
                      ? "Thread ID (optional)"
                      : "Issue or pull request number (optional)"
                  }
                >
                  <Input
                    maxLength={200}
                    pattern={provider === "github" ? "[1-9][0-9]*" : undefined}
                    value={draft.threadId ?? ""}
                    onChange={(event) => setDraft({ ...draft, threadId: event.target.value })}
                  />
                </McpField>
                <fieldset className="space-y-2">
                  <legend className="mb-2 text-sm font-medium">Allowed users</legend>
                  <p className="text-xs text-muted-foreground">
                    Select up to 100 users for this route.
                  </p>
                  {editingId && (
                    <p className="text-xs text-muted-foreground">
                      Current user grants are selected. Saving replaces this route's grants with the
                      checked users.
                    </p>
                  )}
                  {data.users.map((user) => (
                    <label key={user.id} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={draft.principalIds.includes(user.id)}
                        disabled={
                          draft.principalIds.length >= 100 && !draft.principalIds.includes(user.id)
                        }
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            principalIds: checkedValues(
                              draft.principalIds,
                              user.id,
                              event.target.checked
                            ),
                          })
                        }
                      />
                      {user.name ?? user.email} · {user.email}
                    </label>
                  ))}
                  {unavailableUsers.map((id) => (
                    <label key={id} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked
                        onChange={() =>
                          setDraft({
                            ...draft,
                            principalIds: draft.principalIds.filter(
                              (principalId) => principalId !== id
                            ),
                          })
                        }
                      />
                      {id} · Unavailable user; remove before saving
                    </label>
                  ))}
                </fieldset>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={draft.enabled}
                    onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
                  />
                  Enable this route
                </label>
                <div className="flex gap-2">
                  <Button
                    type="submit"
                    disabled={
                      !draft.integrationId ||
                      !draft.agentId ||
                      draft.principalIds.length === 0 ||
                      draft.principalIds.length > 100 ||
                      unavailableUsers.length > 0
                    }
                  >
                    {pending ? "Saving..." : "Save channel route"}
                  </Button>
                  <Button type="button" variant="outline" onClick={() => setDraft(undefined)}>
                    Cancel
                  </Button>
                </div>
              </fieldset>
            </form>
          )}
          <details onToggle={(event) => setShowRoutines(event.currentTarget.open)}>
            <summary className="cursor-pointer text-sm font-medium">
              Automated Routine events
            </summary>
            {showRoutines && (
              <div className="mt-3">
                <NativeRoutineRoutes
                  setup={data.setup}
                  onSaved={(setup) =>
                    setData((current) => (current ? { ...current, setup } : current))
                  }
                />
              </div>
            )}
          </details>
        </>
      )}
      {notice && (
        <p role="status" className="text-xs text-muted-foreground">
          {notice}
        </p>
      )}
    </section>
  );
}
