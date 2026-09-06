import type { Team, TeamAccessExplanation, TeamDelegationPolicy } from "@tulipfarm/schema";
import { type FormEvent, useMemo, useState } from "react";
import { TeamAccessEvidence } from "~/components/access/team-access-evidence";
import { FormStatus } from "~/components/form-status";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Field } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { Link } from "~/components/ui/link";
import { Panel, PanelEmpty } from "~/components/ui/panel";
import { Select } from "~/components/ui/select";
import { Textarea } from "~/components/ui/textarea";
import { ApiError } from "~/lib/api";
import type { AuthzRole } from "~/lib/authz";
import {
  addTeamGrant,
  assignTeamRole,
  deleteTeamGrant,
  explainTeamAccess,
  revokeTeamRole,
  type TeamDirectoryEntry,
  type TeamGrant,
  type TeamRole,
  updateTeamDelegationPolicy,
} from "~/lib/teams";

type Loaded<T> = { ok: true; value: T } | { ok: false; message: string };
type Authority = {
  directRoles: TeamRole[];
  inheritedRoles: TeamRole[];
  directGrants: TeamGrant[];
  inheritedGrants: TeamGrant[];
};

export function TeamRolesAccess({
  team,
  teams,
  authority,
  roles,
  policy,
  canManage,
  isBusinessAdmin,
  onChanged,
}: {
  team: Team;
  teams: readonly TeamDirectoryEntry[];
  authority: Loaded<Authority>;
  roles: Loaded<{ roles: AuthzRole[] }>;
  policy: Loaded<TeamDelegationPolicy>;
  canManage: boolean;
  isBusinessAdmin: boolean;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<{ tone: "error" | "success"; message: string } | null>(null);
  const roleCatalog = roles.ok ? roles.value.roles : [];
  const roleById = useMemo(
    () => new Map(roleCatalog.map((role) => [role.id, role])),
    [roleCatalog]
  );

  async function mutate(key: string, operation: () => Promise<unknown>, success: string) {
    setBusy(key);
    setStatus(null);
    try {
      await operation();
      setStatus({ tone: "success", message: success });
      onChanged();
    } catch (error) {
      setStatus({ tone: "error", message: errorMessage(error) });
    } finally {
      setBusy(null);
    }
  }

  if (!authority.ok) {
    return (
      <Panel title="Roles & access">
        <p className="text-sm text-muted-foreground">
          Role and grant details are unavailable or restricted.
        </p>
      </Panel>
    );
  }

  return (
    <div className="space-y-4">
      {status ? <FormStatus tone={status.tone}>{status.message}</FormStatus> : null}
      <AuthorityList
        title="Direct Roles"
        empty="No Roles are assigned directly to this Team."
        roles={authority.value.directRoles}
        roleById={roleById}
        teams={teams}
        editable={canManage}
        busy={busy}
        onRemove={(roleId) =>
          mutate(`role:${roleId}`, () => revokeTeamRole(team.id, roleId), "Role removed.")
        }
      />
      <AuthorityList
        title="Inherited Roles"
        empty="No Roles are inherited from parent Teams."
        roles={authority.value.inheritedRoles}
        roleById={roleById}
        teams={teams}
        editable={false}
        busy={busy}
        onRemove={() => Promise.resolve()}
      />
      <GrantList
        title="Direct grants"
        empty="No grants are assigned directly to this Team."
        grants={authority.value.directGrants}
        teams={teams}
        editable={canManage}
        busy={busy}
        onRemove={(grantId) =>
          mutate(`grant:${grantId}`, () => deleteTeamGrant(team.id, grantId), "Grant removed.")
        }
      />
      <GrantList
        title="Inherited grants"
        empty="No grants are inherited from parent Teams."
        grants={authority.value.inheritedGrants}
        teams={teams}
        editable={false}
        busy={busy}
        onRemove={() => Promise.resolve()}
      />

      {canManage ? (
        <AssignmentPanel
          team={team}
          roles={roleCatalog}
          policy={policy}
          isBusinessAdmin={isBusinessAdmin}
          busy={busy}
          mutate={mutate}
        />
      ) : null}

      {isBusinessAdmin && policy.ok ? (
        <DelegationEditor
          team={team}
          roles={roleCatalog}
          policy={policy.value}
          busy={busy}
          mutate={mutate}
        />
      ) : null}

      <AccessExplanationPanel team={team} teams={teams} />
    </div>
  );
}

function AuthorityList({
  title,
  empty,
  roles,
  roleById,
  teams,
  editable,
  busy,
  onRemove,
}: {
  title: string;
  empty: string;
  roles: readonly TeamRole[];
  roleById: ReadonlyMap<string, AuthzRole>;
  teams: readonly TeamDirectoryEntry[];
  editable: boolean;
  busy: string | null;
  onRemove: (roleId: string) => Promise<void>;
}) {
  return (
    <Panel title={title} flush>
      {roles.length === 0 ? (
        <PanelEmpty>{empty}</PanelEmpty>
      ) : (
        <ul className="divide-y divide-border">
          {roles.map((role) => {
            const definition = roleById.get(role.roleId);
            return (
              <li key={`${role.sourceTeamId}:${role.roleId}`} className="px-4 py-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">
                        {roleName(definition, role.roleId)}
                      </span>
                      <Badge variant={role.source === "direct" ? "primary" : "neutral"}>
                        {role.source === "direct" ? "Direct" : "Inherited"}
                      </Badge>
                      {definition ? (
                        <Badge variant="neutral">{targetLabel(definition)}</Badge>
                      ) : null}
                    </div>
                    <SourceLine roleOrGrant={role} teams={teams} />
                  </div>
                  <div className="flex items-center gap-2">
                    <Expiry expiresAt={role.expiresAt} />
                    {editable ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={busy === `role:${role.roleId}`}
                        onClick={() => void onRemove(role.roleId)}
                      >
                        {busy === `role:${role.roleId}` ? "Removing…" : "Remove"}
                      </Button>
                    ) : (
                      <span className="text-xs text-muted-foreground">Read-only</span>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

function GrantList({
  title,
  empty,
  grants,
  teams,
  editable,
  busy,
  onRemove,
}: {
  title: string;
  empty: string;
  grants: readonly TeamGrant[];
  teams: readonly TeamDirectoryEntry[];
  editable: boolean;
  busy: string | null;
  onRemove: (grantId: string) => Promise<void>;
}) {
  return (
    <Panel title={title} flush>
      {grants.length === 0 ? (
        <PanelEmpty>{empty}</PanelEmpty>
      ) : (
        <ul className="divide-y divide-border">
          {grants.map((grant) => (
            <li key={grant.id} className="px-4 py-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={grant.effect === "allow" ? "success" : "danger"}>
                      {grant.effect}
                    </Badge>
                    <code className="text-xs">{grant.action}</code>
                    <code className="text-xs">{grant.resourceType}</code>
                    <Badge variant={grant.source === "direct" ? "primary" : "neutral"}>
                      {grant.source === "direct" ? "Direct" : "Inherited"}
                    </Badge>
                  </div>
                  <SourceLine roleOrGrant={grant} teams={teams} />
                </div>
                <div className="flex items-center gap-2">
                  <Expiry expiresAt={grant.expiresAt} />
                  {editable ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={busy === `grant:${grant.id}`}
                      onClick={() => void onRemove(grant.id)}
                    >
                      {busy === `grant:${grant.id}` ? "Removing…" : "Remove"}
                    </Button>
                  ) : (
                    <span className="text-xs text-muted-foreground">Read-only</span>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function AssignmentPanel({
  team,
  roles,
  policy,
  isBusinessAdmin,
  busy,
  mutate,
}: {
  team: Team;
  roles: readonly AuthzRole[];
  policy: Loaded<TeamDelegationPolicy>;
  isBusinessAdmin: boolean;
  busy: string | null;
  mutate: (key: string, operation: () => Promise<unknown>, success: string) => Promise<void>;
}) {
  const [roleId, setRoleId] = useState("");
  const [roleExpiry, setRoleExpiry] = useState("");
  const [grantScope, setGrantScope] = useState("");
  const [grantAction, setGrantAction] = useState("");
  const [grantResource, setGrantResource] = useState("");
  const [grantEffect, setGrantEffect] = useState<"allow" | "deny">("allow");
  const [grantExpiry, setGrantExpiry] = useState("");
  const teamRoles = roles.filter((role) => role.assignableTo.includes("team"));
  const roleById = new Map(roles.map((role) => [role.id, role]));
  const assignableRoles = isBusinessAdmin
    ? teamRoles.map((role) => ({
        id: role.id,
        label: roleName(role, role.id),
        target: targetLabel(role),
      }))
    : policy.ok
      ? policy.value.allowedRoleIds.flatMap((id) => {
          const role = roleById.get(id);
          if (role && !role.assignableTo.includes("team")) return [];
          return [{ id, label: roleName(role, id), target: role ? targetLabel(role) : "Teams" }];
        })
      : [];
  const scopes = policy.ok ? expandScopes(policy.value) : [];
  const selectedScope = scopes.find((scope) => scope.value === grantScope);
  const canCreateGrant = isBusinessAdmin
    ? grantAction.trim() && grantResource.trim()
    : Boolean(selectedScope);

  return (
    <Panel
      title="Assign direct authority"
      description={
        isBusinessAdmin
          ? "Company admins may assign any Team-compatible Role or grant."
          : "Team admins may assign only the Roles and grant scopes delegated to this Team."
      }
    >
      {!roles.length && isBusinessAdmin ? (
        <FormStatus tone="error">
          The Role catalog is unavailable. No Role can be selected safely.
        </FormStatus>
      ) : null}
      {!isBusinessAdmin && !policy.ok ? (
        <FormStatus tone="error">
          The delegation policy is unavailable. Assignment controls are disabled.
        </FormStatus>
      ) : null}
      <div className="grid gap-5 xl:grid-cols-2">
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (!roleId) return;
            void mutate(
              "assign-role",
              () => assignTeamRole(team.id, roleId, endOfDay(roleExpiry)),
              "Role assigned."
            ).then(() => {
              setRoleId("");
              setRoleExpiry("");
            });
          }}
        >
          <h3 className="text-sm font-medium">Assign Role</h3>
          <Field label="Team-compatible Role" required>
            <Select
              value={roleId}
              disabled={(isBusinessAdmin && !roles.length) || (!isBusinessAdmin && !policy.ok)}
              onChange={(event) => setRoleId(event.target.value)}
            >
              <option value="">Choose one…</option>
              {assignableRoles.map((role) => (
                <option key={role.id} value={role.id}>
                  {role.label} — {role.target}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Until (optional)">
            <Input
              type="date"
              value={roleExpiry}
              onChange={(event) => setRoleExpiry(event.target.value)}
            />
          </Field>
          <Button type="submit" disabled={!roleId || busy === "assign-role"}>
            {busy === "assign-role" ? "Assigning…" : "Assign Role"}
          </Button>
        </form>

        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            const action = isBusinessAdmin ? grantAction.trim() : selectedScope?.action;
            const resourceType = isBusinessAdmin
              ? grantResource.trim()
              : selectedScope?.resourceType;
            if (!action || !resourceType) return;
            void mutate(
              "add-grant",
              () =>
                addTeamGrant(team.id, {
                  action,
                  resourceType,
                  effect: grantEffect,
                  ...(endOfDay(grantExpiry) ? { expiresAt: endOfDay(grantExpiry) } : {}),
                }),
              "Grant added."
            ).then(() => {
              setGrantScope("");
              setGrantAction("");
              setGrantResource("");
              setGrantExpiry("");
            });
          }}
        >
          <h3 className="text-sm font-medium">Add direct grant</h3>
          {isBusinessAdmin ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Action" required>
                <Input
                  value={grantAction}
                  onChange={(event) => setGrantAction(event.target.value)}
                />
              </Field>
              <Field label="Resource type" required>
                <Input
                  value={grantResource}
                  onChange={(event) => setGrantResource(event.target.value)}
                />
              </Field>
            </div>
          ) : (
            <Field label="Delegated grant scope" required>
              <Select
                value={grantScope}
                disabled={!policy.ok}
                onChange={(event) => setGrantScope(event.target.value)}
              >
                <option value="">Choose one…</option>
                {scopes.map((scope) => (
                  <option key={scope.value} value={scope.value}>
                    {scope.action} on {scope.resourceType}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Effect" required>
              <Select
                value={grantEffect}
                onChange={(event) => setGrantEffect(event.target.value as "allow" | "deny")}
              >
                <option value="allow">Allow</option>
                <option value="deny">Deny</option>
              </Select>
            </Field>
            <Field label="Until (optional)">
              <Input
                type="date"
                value={grantExpiry}
                onChange={(event) => setGrantExpiry(event.target.value)}
              />
            </Field>
          </div>
          <Button type="submit" disabled={!canCreateGrant || busy === "add-grant"}>
            {busy === "add-grant" ? "Adding…" : "Add grant"}
          </Button>
        </form>
      </div>
    </Panel>
  );
}

function DelegationEditor({
  team,
  roles,
  policy,
  busy,
  mutate,
}: {
  team: Team;
  roles: readonly AuthzRole[];
  policy: TeamDelegationPolicy;
  busy: string | null;
  mutate: (key: string, operation: () => Promise<unknown>, success: string) => Promise<void>;
}) {
  const teamRoles = roles.filter((role) => role.assignableTo.includes("team"));
  const [allowedRoleIds, setAllowedRoleIds] = useState(policy.allowedRoleIds);
  const [scopeText, setScopeText] = useState(formatScopes(policy));
  const [parseError, setParseError] = useState<string | null>(null);

  async function save(event: FormEvent) {
    event.preventDefault();
    let allowedGrantScopes: TeamDelegationPolicy["allowedGrantScopes"];
    try {
      allowedGrantScopes = parseScopes(scopeText);
      setParseError(null);
    } catch (error) {
      setParseError(error instanceof Error ? error.message : "Invalid grant scopes.");
      return;
    }
    await mutate(
      "delegation",
      () =>
        updateTeamDelegationPolicy(team.id, {
          allowedRoleIds,
          allowedGrantScopes,
          revision: policy.revision,
        }),
      "Delegation policy saved."
    );
  }

  return (
    <Panel
      title="Team admin delegation"
      description="Company admins choose the authority this Team's admins may assign."
    >
      <form className="space-y-4" onSubmit={save}>
        <fieldset>
          <legend className="text-sm font-medium">Roles Team admins may assign</legend>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {teamRoles.map((role) => {
              const id = `delegated-role-${role.id}`;
              return (
                <label key={role.id} htmlFor={id} className="flex items-start gap-2 text-sm">
                  <Checkbox
                    id={id}
                    checked={allowedRoleIds.includes(role.id)}
                    onChange={(event) =>
                      setAllowedRoleIds((current) =>
                        event.target.checked
                          ? [...current, role.id]
                          : current.filter((id) => id !== role.id)
                      )
                    }
                  />
                  <span>
                    {roleName(role, role.id)}
                    <span className="block text-xs text-muted-foreground">{targetLabel(role)}</span>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>
        <Field
          label="Grant scopes Team admins may assign"
          help="One scope per line: comma-separated actions | comma-separated resource types."
          error={parseError ?? undefined}
        >
          <Textarea
            value={scopeText}
            onChange={(event) => setScopeText(event.target.value)}
            placeholder="record.read, record.update | ticket, customer"
          />
        </Field>
        <Button type="submit" disabled={busy === "delegation"}>
          {busy === "delegation" ? "Saving…" : "Save delegation policy"}
        </Button>
      </form>
    </Panel>
  );
}

function AccessExplanationPanel({
  team,
  teams,
}: {
  team: Team;
  teams: readonly TeamDirectoryEntry[];
}) {
  const [principalId, setPrincipalId] = useState("");
  const [action, setAction] = useState("");
  const [resourceType, setResourceType] = useState("");
  const [result, setResult] = useState<TeamAccessExplanation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function check(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setResult(
        await explainTeamAccess(team.id, {
          principalId: principalId.trim(),
          action: action.trim(),
          resourceType: resourceType.trim(),
        })
      );
    } catch (caught) {
      setResult(null);
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel
      title="Why this access?"
      description="Check a principal and see the Team membership path, ancestry, Role, grant, and deny source."
    >
      <form className="grid gap-3 md:grid-cols-3" onSubmit={check}>
        <Field label="Principal ID" required>
          <Input value={principalId} onChange={(event) => setPrincipalId(event.target.value)} />
        </Field>
        <Field label="Action" required>
          <Input
            value={action}
            onChange={(event) => setAction(event.target.value)}
            placeholder="record.read"
          />
        </Field>
        <Field label="Resource type" required>
          <Input
            value={resourceType}
            onChange={(event) => setResourceType(event.target.value)}
            placeholder="ticket"
          />
        </Field>
        <div className="md:col-span-3">
          <Button
            type="submit"
            disabled={busy || !principalId.trim() || !action.trim() || !resourceType.trim()}
          >
            {busy ? "Checking…" : "Explain access"}
          </Button>
        </div>
      </form>
      {error ? <FormStatus tone="error">{error}</FormStatus> : null}
      {result ? (
        <div className="mt-4">
          <TeamAccessEvidence explanation={result} teams={teams} />
        </div>
      ) : null}
    </Panel>
  );
}

function SourceLine({
  roleOrGrant,
  teams,
}: {
  roleOrGrant: TeamRole | TeamGrant;
  teams: readonly TeamDirectoryEntry[];
}) {
  const source = teams.find((team) => team.id === roleOrGrant.sourceTeamId);
  return (
    <p className="mt-1 text-xs text-muted-foreground">
      Source Team:{" "}
      {source ? (
        <Link
          to={`/teams/${encodeURIComponent(source.slug)}?section=roles`}
          className="hover:underline"
        >
          {source.displayName}
        </Link>
      ) : (
        roleOrGrant.sourceTeamId
      )}
      {roleOrGrant.pathTeamIds.length > 1
        ? ` · ${roleOrGrant.pathTeamIds.length - 1} ancestor ${roleOrGrant.pathTeamIds.length === 2 ? "step" : "steps"}`
        : ""}
    </p>
  );
}

function Expiry({ expiresAt }: { expiresAt: string | null }) {
  return expiresAt ? (
    <Badge variant="warning">
      Until {new Date(expiresAt).toLocaleDateString(undefined, { dateStyle: "medium" })}
    </Badge>
  ) : null;
}

function roleName(role: AuthzRole | undefined, fallback: string): string {
  return role?.displayName?.trim() || fallback;
}

export function targetLabel(role: Pick<AuthzRole, "assignableTo">): string {
  const people = role.assignableTo.includes("user");
  const teams = role.assignableTo.includes("team");
  if (people && teams) return "People & Teams";
  if (people) return "People";
  if (teams) return "Teams";
  return "Other principals";
}

function endOfDay(value: string): string | undefined {
  if (!value) return undefined;
  return new Date(`${value}T23:59:59`).toISOString();
}

function expandScopes(policy: TeamDelegationPolicy) {
  return policy.allowedGrantScopes.flatMap((scope) =>
    scope.actions.flatMap((action) =>
      scope.resourceTypes.map((resourceType) => ({
        action,
        resourceType,
        value: `${action}\u0000${resourceType}`,
      }))
    )
  );
}

function formatScopes(policy: TeamDelegationPolicy): string {
  return policy.allowedGrantScopes
    .map((scope) => `${scope.actions.join(", ")} | ${scope.resourceTypes.join(", ")}`)
    .join("\n");
}

function parseScopes(value: string): TeamDelegationPolicy["allowedGrantScopes"] {
  if (!value.trim()) return [];
  return value
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line, index) => {
      const [actionsPart, resourcesPart, extra] = line.split("|");
      const actions =
        actionsPart
          ?.split(",")
          .map((item) => item.trim())
          .filter(Boolean) ?? [];
      const resourceTypes =
        resourcesPart
          ?.split(",")
          .map((item) => item.trim())
          .filter(Boolean) ?? [];
      if (extra !== undefined || actions.length === 0 || resourceTypes.length === 0) {
        throw new Error(`Line ${index + 1} must use actions | resource types.`);
      }
      return { actions, resourceTypes };
    });
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) return "This assignment is outside your delegated authority.";
    if (error.status === 409) return "This page is stale. Reload it and try again.";
    return error.message;
  }
  return "Could not update Team authority.";
}
