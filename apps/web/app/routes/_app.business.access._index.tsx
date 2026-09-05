/* User-role Rows are trigger-owned, and team-inherited access cannot be removed here. */

import {
  type ClientLoaderFunctionArgs,
  type MetaFunction,
  useLoaderData,
  useNavigation,
  useRevalidator,
  useRouteError,
  useSearchParams,
} from "@remix-run/react";
import { useMemo, useState } from "react";
import { PartyLine } from "~/components/access/access-bits";
import { InviteForm, IssuedLink } from "~/components/access/invite-flow";
import { LevelsPanel } from "~/components/access/levels-panel";
import { PersonDetail, PersonRow } from "~/components/access/person-panel";
import { AccessTabs } from "~/components/access-tabs";
import { FormStatus } from "~/components/form-status";
import { Search, UserPlus, Users } from "~/components/icons";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Modal } from "~/components/ui/modal";
import { Panel, PanelEmpty } from "~/components/ui/panel";
import { Sheet } from "~/components/ui/sheet";
import {
  buildDirectory,
  type Directory,
  lookupParty,
  matchesQuery,
  type Party,
} from "~/lib/access-directory";
import { roleNamer, summarizeRole } from "~/lib/access-language";
import { ApiError } from "~/lib/api";
import {
  type AuthzRole,
  type EffectiveGrants,
  getEffectiveGrants,
  listCapabilities,
  listRoleAssignees,
  listRoles,
} from "~/lib/authz";
import { getTeamAuthority, listTeams } from "~/lib/teams";
import { createUser, type Invite, listUsers, type UserStatus } from "~/lib/users";

export const meta: MetaFunction = () => [{ title: "People · Access · tulipfarm" }];

/** Trigger-owned account Roles are shown but not grantable here. */
const ACCOUNT_ROLE_IDS: ReadonlySet<string> = new Set(["admin", "member"]);

export type SelectedAccess =
  | { status: "ok"; effective: EffectiveGrants }
  | { status: "error"; message: string };

export async function clientLoader({ request }: ClientLoaderFunctionArgs) {
  const selectedId = new URL(request.url).searchParams.get("person")?.trim() ?? "";

  const [users, { roles }, teams, catalog] = await Promise.all([
    listUsers(),
    listRoles(),
    loadTeamAccess(),
    // The catalog is what makes "create a level" possible at all. It is admin-only, and this page
    // already is, but a deployment without the authoring routes wired still renders — the builder
    // simply is not offered, rather than the whole page failing.
    listCapabilities().catch(() => null),
  ]);
  const [assignments, selectedAccess] = await Promise.all([
    Promise.all(
      roles.map(async (role) => ({
        roleId: role.id,
        assignees: (await listRoleAssignees(role.id)).assignees,
      }))
    ),
    loadSelected(selectedId),
  ]);

  return { users, roles, assignments, teams, selectedId, selectedAccess, catalog };
}

async function loadSelected(principalId: string): Promise<SelectedAccess | null> {
  if (!principalId) return null;
  try {
    return { status: "ok", effective: await getEffectiveGrants(principalId) };
  } catch (err) {
    return { status: "error", message: errorMessage(err) };
  }
}

type LoaderData = Awaited<ReturnType<typeof clientLoader>>;
type TeamAccessSummary = {
  id: string;
  members: Array<{ principalId: string }>;
  roles: Array<{ roleId: string }>;
};

/** Everything one row needs, assembled once rather than re-derived per render. */
export type PersonAccess = {
  party: Party;
  /** From `users.role`. Read-only here — see the module comment. */
  accountRole: string;
  /** Whether they can sign in at all, which no amount of granted access can substitute for. */
  status: UserStatus;
  /** Roles granted to this person alone, excluding the account-derived pair. */
  directRoles: Array<{ roleId: string; expiresAt: string | null }>;
  /** Teams this person belongs to, and the Roles those teams carry. */
  teams: Array<{ id: string; roleIds: string[] }>;
};

export default function AccessPeople() {
  const data = useLoaderData<typeof clientLoader>();
  const revalidator = useRevalidator();
  const navigation = useNavigation();
  const [searchParams, setSearchParams] = useSearchParams();
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);
  const [issued, setIssued] = useState<{ email: string; invite: Invite } | null>(null);

  const directory = useMemo(() => buildDirectory(data.users), [data.users]);
  const people = useMemo(() => buildPeople(data, directory), [data, directory]);
  const others = useMemo(() => buildNonPeople(data, directory), [data, directory]);
  const keepers = useMemo(() => findKeepers(data, people), [data, people]);
  const visible = people.filter((person) => matchesQuery(person.party, query));

  const selected = people.find((person) => person.party.principalId === data.selectedId) ?? null;
  const selectedOther = others.find((party) => party.principalId === data.selectedId) ?? null;

  function select(principalId: string | null) {
    setError(null);
    const next = new URLSearchParams(searchParams);
    if (principalId) {
      next.set("person", principalId);
    } else {
      next.delete("person");
    }
    setSearchParams(next);
  }

  async function mutate<T>(key: string, operation: () => Promise<T>): Promise<T | null> {
    setError(null);
    setBusy(key);
    try {
      const result = await operation();
      revalidator.revalidate();
      return result;
    } catch (err) {
      setError(errorMessage(err));
      return null;
    } finally {
      setBusy(null);
    }
  }

  /** Invite links are shown once, so store them above both modals. */
  function show(email: string, invite: Invite | null) {
    if (invite) setIssued({ email, invite });
  }

  const loadingSelection = navigation.state === "loading";

  return (
    <div className="space-y-6">
      <AccessTabs />

      {error ? <FormStatus tone="error">{error}</FormStatus> : null}

      {issued ? <IssuedLink issued={issued} onDismiss={() => setIssued(null)} /> : null}

      <Panel
        title="Who can do what"
        description="Everyone who can sign in, and what each of them is allowed to do."
        actions={
          <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
            <div className="relative w-full sm:w-auto">
              <Search
                aria-hidden
                className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                type="search"
                className="w-full pl-8 sm:w-56"
                placeholder="Search people"
                aria-label="Search people"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            <Button className="w-full sm:w-auto" onClick={() => setInviting(true)}>
              <UserPlus aria-hidden className="size-4" />
              Invite someone
            </Button>
          </div>
        }
        flush
      >
        {people.length === 0 ? (
          <PanelEmpty>Nobody yet. Invite the first person to get started.</PanelEmpty>
        ) : visible.length === 0 ? (
          <PanelEmpty>Nobody matches “{query}”.</PanelEmpty>
        ) : (
          <ul className="divide-y divide-border">
            {visible.map((person) => (
              <li key={person.party.principalId}>
                <PersonRow
                  person={person}
                  heldTitles={heldRoleTitles(person, data.roles)}
                  onManage={select}
                />
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {others.length > 0 ? (
        <Panel
          title="Apps and automations"
          description="These are not people. They hold access so an assistant, a routine or another system can act on its own."
          flush
        >
          <ul className="divide-y divide-border">
            {others.map((party) => (
              <li key={party.principalId} className="flex items-center gap-3 px-4 py-3">
                <PartyLine party={party} />
                <Button variant="outline" size="sm" onClick={() => select(party.principalId)}>
                  View access
                </Button>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}

      <LevelsPanel
        roles={data.roles}
        catalog={data.catalog}
        onChanged={revalidator.revalidate}
        getErrorMessage={errorMessage}
      />

      <Modal
        open={inviting}
        onClose={() => setInviting(false)}
        title="Invite someone"
        className="max-w-lg"
      >
        <InviteForm
          busy={busy === "invite"}
          onInvite={async (email) => {
            const result = await mutate("invite", () => createUser(email));
            if (!result) return false;
            show(result.user.email, result.invite);
            setInviting(false);
            return true;
          }}
        />
      </Modal>

      <Sheet
        open={Boolean(data.selectedId)}
        onClose={() => select(null)}
        title={
          selected
            ? `${selected.party.name}'s access`
            : selectedOther
              ? `${selectedOther.name}'s access`
              : "Access"
        }
        className="sm:max-w-xl"
      >
        {loadingSelection ? (
          <p className="py-6 text-sm text-muted-foreground">Loading…</p>
        ) : (
          <PersonDetail
            person={selected}
            otherParty={selectedOther}
            access={data.selectedAccess}
            roles={data.roles}
            keepers={keepers}
            busy={busy}
            mutate={mutate}
            onIssued={show}
            accountRoleIds={ACCOUNT_ROLE_IDS}
            isLastKeeper={isLastKeeper}
            teamTitle={teamTitle}
            expiryIso={expiryIso}
          />
        )}
      </Sheet>
    </div>
  );
}

// ── Derivation ───────────────────────────────────────────────────────────────
function buildPeople(data: LoaderData, directory: Directory): PersonAccess[] {
  return data.users.map((user) => ({
    party: lookupParty(directory, user.id),
    accountRole: user.role,
    status: user.status,
    directRoles: data.assignments
      .filter((entry) => !ACCOUNT_ROLE_IDS.has(entry.roleId))
      .flatMap((entry) =>
        entry.assignees
          .filter((assignee) => assignee.principalId === user.id)
          .map((assignee) => ({ roleId: entry.roleId, expiresAt: assignee.expiresAt }))
      ),
    teams: teamsFor(data.teams, user.id),
  }));
}

async function loadTeamAccess(): Promise<TeamAccessSummary[]> {
  const { teams } = await listTeams();
  return Promise.all(
    teams.map(async (team) => {
      const authority = await getTeamAuthority(team.id);
      return {
        id: team.slug,
        members: team.members,
        roles: [...authority.directRoles, ...authority.inheritedRoles],
      };
    })
  );
}

function teamsFor(teams: TeamAccessSummary[], principalId: string) {
  return teams
    .filter((team) => team.members.some((member) => member.principalId === principalId))
    .map((team) => ({ id: team.id, roleIds: team.roles.map((role) => role.roleId) }));
}

/** Last-unrestricted checks must count direct, account-derived, and team-derived sources. */
export type KeeperSource = { principalId: string; key: string };

function findKeepers(data: LoaderData, people: PersonAccess[]): KeeperSource[] {
  const unrestricted = new Set(
    data.roles.filter((role) => summarizeRole(role).unrestricted).map((role) => role.id)
  );
  const sources: KeeperSource[] = [];

  for (const person of people) {
    const id = person.party.principalId;
    // A disabled or never-opened account cannot sign in, so it can rescue nobody.
    if (person.status !== "active") continue;
    if (unrestricted.has(person.accountRole)) sources.push({ principalId: id, key: "account" });
    for (const held of person.directRoles) {
      if (unrestricted.has(held.roleId))
        sources.push({ principalId: id, key: `role:${held.roleId}` });
    }
    for (const team of person.teams) {
      for (const roleId of team.roleIds) {
        if (unrestricted.has(roleId)) sources.push({ principalId: id, key: `team:${team.id}` });
      }
    }
  }

  return sources;
}

/** Whether taking this Role from this person would leave nobody able to give it back. */
function isLastKeeper(keepers: KeeperSource[], principalId: string, roleId: string): boolean {
  if (keepers.length === 0) return false;
  return keepers.every(
    (source) => source.principalId === principalId && source.key === `role:${roleId}`
  );
}

/** Non-user principals can hold direct Roles, team access, or both, so collect both sources. */
function buildNonPeople(data: LoaderData, directory: Directory): Party[] {
  const ids = new Set<string>();
  for (const entry of data.assignments) {
    for (const assignee of entry.assignees) ids.add(assignee.principalId);
  }
  for (const team of data.teams) {
    for (const member of team.members) ids.add(member.principalId);
  }

  return [...ids]
    .filter((id) => !directory.has(id))
    .sort((a, b) => a.localeCompare(b))
    .map((id) => lookupParty(directory, id));
}

function heldRoleTitles(person: PersonAccess, roles: AuthzRole[]): string[] {
  const known = new Set(roles.map((role) => role.id));
  const nameOf = roleNamer(roles);
  const titles = new Set<string>();
  for (const held of person.directRoles) titles.add(nameOf(held.roleId));
  for (const team of person.teams) {
    for (const roleId of team.roleIds) {
      if (!ACCOUNT_ROLE_IDS.has(roleId) && known.has(roleId)) titles.add(nameOf(roleId));
    }
  }
  return [...titles].sort((a, b) => a.localeCompare(b));
}

/** Teams are stored under a slug; show the words back. */
export function teamTitle(teamId: string): string {
  const words = teamId.replaceAll(/[._-]+/g, " ").trim();
  if (words.length === 0) return teamId;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Date-only expiry means end of that local day. */
function expiryIso(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  const date = new Date(`${trimmed}T23:59:59`);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function errorMessage(err: unknown) {
  if (err instanceof ApiError) {
    return err.status === 403 ? "You are not an admin of this business." : err.message;
  }
  return "Could not reach the API.";
}

export function ErrorBoundary() {
  const error = useRouteError();
  return (
    <div className="space-y-6">
      <AccessTabs />
      <FormStatus tone="error">{errorMessage(error)}</FormStatus>
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Users aria-hidden className="size-4" />
        Only an admin can see who has access or change it.
      </p>
    </div>
  );
}
