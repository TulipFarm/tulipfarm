/* Which team an Agent works for. The answer decides who can open what that Agent writes. */

import { type MetaFunction, useLoaderData, useRevalidator } from "@remix-run/react";
import { useMemo, useState } from "react";
import { AccessTabs } from "~/components/access-tabs";
import { FormStatus } from "~/components/form-status";
import { Button } from "~/components/ui/button";
import { Panel, PanelEmpty, PanelRow } from "~/components/ui/panel";
import { Select } from "~/components/ui/select";
import { roleTitle } from "~/lib/access-language";
import { type AgentSummary, listAgents } from "~/lib/agents";
import { ApiError } from "~/lib/api";
import {
  type AuthzRole,
  assignRole,
  listRoleAssignees,
  listRoles,
  registerPrincipal,
  revokeRole,
} from "~/lib/authz";

export const meta: MetaFunction = () => [{ title: "Agents · Access · tulipfarm" }];

/**
 * An Agent's Principal id is its Soul name — the same string the runtime carries as `agentId` —
 * so a Role granted here is the one that Agent is found to hold when it writes a File.
 */
export async function clientLoader() {
  const [agents, { roles }] = await Promise.all([listAgents(), listRoles()]);
  const held = await Promise.all(
    roles.map(async (role) => ({
      roleId: role.id,
      assignees: (await listRoleAssignees(role.id)).assignees.map((a) => a.principalId),
    }))
  );
  return { agents, roles, held };
}

export default function AccessAgents() {
  const { agents, roles, held } = useLoaderData<typeof clientLoader>();
  const revalidator = useRevalidator();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Record<string, string>>({});

  const rolesByAgent = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const { roleId, assignees } of held) {
      for (const principalId of assignees) {
        map.set(principalId, [...(map.get(principalId) ?? []), roleId]);
      }
    }
    return map;
  }, [held]);

  const openToAgents = useMemo(
    () => roles.filter((role) => role.assignableTo.includes("agent")),
    [roles]
  );

  async function mutate(key: string, operation: () => Promise<unknown>) {
    setError(null);
    setBusy(key);
    try {
      await operation();
      revalidator.revalidate();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-6">
      <AccessTabs />

      {error ? <FormStatus tone="error">{error}</FormStatus> : null}

      <Panel
        title="Which team does each agent work for?"
        description={
          "Give an agent a team, and every document that agent writes can be opened by everyone " +
          "in that team. Nobody has to forward it. To let one more person in, such as a manager, " +
          "give that person the same team on the People tab."
        }
      >
        {agents.length === 0 ? (
          <PanelEmpty>No agents yet. Ask for one in chat and it will appear here.</PanelEmpty>
        ) : openToAgents.length === 0 ? (
          <PanelEmpty>
            No team accepts agents yet. Edit a team on the Teams tab to let agents join it.
          </PanelEmpty>
        ) : (
          agents.map((agent) => (
            <AgentRow
              key={agent.name}
              agent={agent}
              roles={roles}
              holds={rolesByAgent.get(agent.name) ?? []}
              busy={busy}
              picked={picked[agent.name] ?? ""}
              onPick={(roleId) => setPicked((prev) => ({ ...prev, [agent.name]: roleId }))}
              onAdd={(roleId) =>
                mutate(`add:${agent.name}`, async () => {
                  // The Soul never writes a Principal row, so the grant has to create one first.
                  await registerPrincipal(agent.name, "agent");
                  await assignRole(roleId, agent.name);
                  setPicked((prev) => ({ ...prev, [agent.name]: "" }));
                })
              }
              onRemove={(roleId) =>
                mutate(`remove:${agent.name}:${roleId}`, () => revokeRole(roleId, agent.name))
              }
            />
          ))
        )}
      </Panel>
    </div>
  );
}

function AgentRow({
  agent,
  roles,
  holds,
  busy,
  picked,
  onPick,
  onAdd,
  onRemove,
}: {
  agent: AgentSummary;
  roles: readonly AuthzRole[];
  holds: readonly string[];
  busy: string | null;
  picked: string;
  onPick: (roleId: string) => void;
  onAdd: (roleId: string) => void;
  onRemove: (roleId: string) => void;
}) {
  const namer = (roleId: string) =>
    roleTitle(roleId, roles.find((role) => role.id === roleId)?.displayName);
  // A team authored for people only cannot hold an Agent, so offering it would only produce a
  // refusal the admin cannot act on.
  const addable = roles.filter(
    (role) => !holds.includes(role.id) && role.assignableTo.includes("agent")
  );

  return (
    <PanelRow className="flex-col items-start gap-3 sm:flex-row sm:items-center">
      <div className="min-w-0">
        <p className="truncate text-sm text-foreground">{agent.label ?? agent.name}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {holds.length === 0
            ? "No team yet, only the person who asks can open what it writes."
            : `Writes for ${holds.map(namer).join(", ")}.`}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
        {holds.map((roleId) => (
          <Button
            key={roleId}
            variant="outline"
            size="sm"
            disabled={busy === `remove:${agent.name}:${roleId}`}
            onClick={() => onRemove(roleId)}
          >
            {busy === `remove:${agent.name}:${roleId}` ? "Removing…" : `Remove ${namer(roleId)}`}
          </Button>
        ))}

        {addable.length > 0 ? (
          <>
            <Select
              aria-label={`Team for ${agent.name}`}
              value={picked}
              onChange={(event) => onPick(event.target.value)}
            >
              <option value="">Choose a team…</option>
              {addable.map((role) => (
                <option key={role.id} value={role.id}>
                  {roleTitle(role.id, role.displayName)}
                </option>
              ))}
            </Select>
            <Button
              size="sm"
              disabled={picked === "" || busy === `add:${agent.name}`}
              onClick={() => onAdd(picked)}
            >
              {busy === `add:${agent.name}` ? "Adding…" : "Add"}
            </Button>
          </>
        ) : null}
      </div>
    </PanelRow>
  );
}

function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    // `not_assignable` means the team was authored for people only; say so in those words.
    return err.message.includes("not_assignable")
      ? "That team was not set up to include agents. Edit the team to allow agents, then try again."
      : err.message;
  }
  return err instanceof Error ? err.message : String(err);
}
