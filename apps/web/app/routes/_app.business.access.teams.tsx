/* A business with a hundred teams should scan like an address book, not a stack of forms. */

import { type MetaFunction, useLoaderData, useRevalidator, useRouteError } from "@remix-run/react";
import { type FormEvent, useMemo, useState } from "react";
import { type Mutate, TeamSheet, teamCapabilities } from "~/components/access/team-sheet";
import { AccessTabs } from "~/components/access-tabs";
import { FormStatus } from "~/components/form-status";
import { Button } from "~/components/ui/button";
import { Field, FieldAction } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { Panel, PanelEmpty } from "~/components/ui/panel";
import { Select } from "~/components/ui/select";
import { Sheet } from "~/components/ui/sheet";
import { buildDirectory, type Directory, lookupParty } from "~/lib/access-directory";
import { roleTitle, summarizeRole } from "~/lib/access-language";
import { ApiError } from "~/lib/api";
import {
  type AuthzGroupDetail,
  type AuthzRole,
  createGroup,
  listCapabilities,
  listGroups,
  listRoles,
} from "~/lib/authz";
import { listUsers } from "~/lib/users";

export const meta: MetaFunction = () => [{ title: "Teams · Access · tulipfarm" }];

type TeamFilter = "all" | "no-access" | "empty";
type TeamSort = "name-asc" | "name-desc" | "members-desc" | "members-asc";

export async function clientLoader() {
  const [{ groups: teams }, { roles }, users, catalog] = await Promise.all([
    listGroups(),
    listRoles(),
    listUsers(),
    listCapabilities().catch(() => null),
  ]);
  return { teams, roles, users, catalog };
}

export default function AccessTeams() {
  const { teams, roles, users, catalog } = useLoaderData<typeof clientLoader>();
  const revalidator = useRevalidator();
  const directory = useMemo(() => buildDirectory(users), [users]);
  const roleById = useMemo(() => new Map(roles.map((role) => [role.id, role])), [roles]);
  const [name, setName] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<TeamFilter>("all");
  const [sort, setSort] = useState<TeamSort>("name-asc");
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const slug = slugify(name);
  const taken = teams.some((team) => team.id === slug);
  const selectedTeam = teams.find((team) => team.id === selectedTeamId) ?? null;

  const visibleTeams = useMemo(
    () => visibleTeamsFor(teams, roleById, directory, query, filter, sort),
    [teams, roleById, directory, query, filter, sort]
  );
  const listIsNarrowed = query.trim().length > 0 || filter !== "all";

  const mutate: Mutate = async (key, operation) => {
    setError(null);
    setBusy(key);
    try {
      await operation();
      revalidator.revalidate();
      return true;
    } catch (err) {
      setError(errorMessage(err));
      return false;
    } finally {
      setBusy(null);
    }
  };

  async function onCreate(event: FormEvent) {
    event.preventDefault();
    if (!slug || taken) return;
    if (await mutate("create", () => createGroup(slug))) setName("");
  }

  function clearListControls() {
    setQuery("");
    setFilter("all");
    setSort("name-asc");
  }

  return (
    <div className="space-y-6">
      <AccessTabs />

      {error ? <FormStatus tone="error">{error}</FormStatus> : null}

      <Panel
        title="Start a team"
        description="Make one team, then give access to everyone in it from one place."
      >
        <form className="grid gap-3 sm:grid-cols-[1fr_auto]" onSubmit={onCreate}>
          <Field
            label="Team name"
            required
            help={
              taken
                ? "A team with that name already exists."
                : slug
                  ? `Saved as “${slug}”.`
                  : "For example: Kitchen, Front of house, Accounts."
            }
          >
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Kitchen"
              aria-invalid={taken || undefined}
            />
          </Field>
          <FieldAction>
            <Button
              className="w-full sm:w-auto"
              type="submit"
              disabled={busy === "create" || slug.length === 0 || taken}
            >
              {busy === "create" ? "Creating…" : "Create team"}
            </Button>
          </FieldAction>
        </form>
      </Panel>

      <Panel
        title="Teams"
        description="Search, sort, and open a team to change who is in it or what they can do."
        flush
      >
        {teams.length === 0 ? (
          <PanelEmpty>
            No teams yet. You do not need one. You can give a person access directly on the People
            tab, but a team saves repeating yourself.
          </PanelEmpty>
        ) : (
          <>
            <div className="grid gap-3 px-4 py-4 lg:grid-cols-[1fr_12rem_12rem]">
              <Field label="Search teams">
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Team name, person, or email"
                />
              </Field>
              <Field label="Filter teams">
                <Select
                  value={filter}
                  onChange={(event) => setFilter(event.target.value as TeamFilter)}
                >
                  <option value="all">All teams</option>
                  <option value="no-access">No access yet</option>
                  <option value="empty">Nobody in the team</option>
                </Select>
              </Field>
              <Field label="Sort teams">
                <Select value={sort} onChange={(event) => setSort(event.target.value as TeamSort)}>
                  <option value="name-asc">Name A-Z</option>
                  <option value="name-desc">Name Z-A</option>
                  <option value="members-desc">Most people first</option>
                  <option value="members-asc">Fewest people first</option>
                </Select>
              </Field>
            </div>

            <div className="border-border border-t px-4 py-2 text-xs text-muted-foreground">
              {listIsNarrowed
                ? `Showing ${visibleTeams.length} of ${teams.length} ${teamCountLabel(teams.length)}.`
                : `${teams.length} ${teamCountLabel(teams.length)}.`}
            </div>

            {visibleTeams.length === 0 ? (
              <PanelEmpty className="border-border border-t">
                No teams match that search or filter.{" "}
                <Button
                  type="button"
                  variant="link"
                  className="h-auto p-0"
                  onClick={clearListControls}
                >
                  Clear it
                </Button>
                .
              </PanelEmpty>
            ) : (
              <ul className="divide-y divide-border border-border border-t">
                {visibleTeams.map((team) => (
                  <li key={team.id}>
                    <button
                      type="button"
                      className="flex w-full cursor-pointer flex-col gap-2 px-4 py-3 text-left transition-colors hover:bg-accent focus-visible:-outline-offset-2 focus-visible:rounded-md sm:grid sm:grid-cols-[minmax(0,1fr)_8rem_minmax(12rem,1.4fr)] sm:items-center"
                      onClick={() => setSelectedTeamId(team.id)}
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium text-foreground">
                          {teamTitle(team.id)}
                        </span>
                        <span className="block text-xs text-muted-foreground">Open team</span>
                      </span>
                      <span className="text-sm text-muted-foreground">
                        {memberCountLabel(team.members.length)}
                      </span>
                      <span className="line-clamp-2 text-sm text-muted-foreground">
                        {teamAccessSummary(team, roleById)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </Panel>

      <Sheet
        open={Boolean(selectedTeam)}
        onClose={() => setSelectedTeamId(null)}
        title={selectedTeam ? `${teamTitle(selectedTeam.id)} team` : "Team"}
        className="sm:max-w-xl"
      >
        {selectedTeam ? (
          <TeamSheet
            key={selectedTeam.id}
            team={selectedTeam}
            roles={roles}
            roleById={roleById}
            catalog={catalog}
            onLevelCreated={revalidator.revalidate}
            users={users}
            directory={directory}
            busy={busy}
            mutate={mutate}
            onDeleted={() => setSelectedTeamId(null)}
          />
        ) : null}
      </Sheet>
    </div>
  );
}

function visibleTeamsFor(
  teams: readonly AuthzGroupDetail[],
  roleById: Map<string, AuthzRole>,
  directory: Directory,
  query: string,
  filter: TeamFilter,
  sort: TeamSort
): AuthzGroupDetail[] {
  const needle = query.trim().toLowerCase();
  return teams
    .filter((team) => teamMatchesQuery(team, directory, needle))
    .filter((team) => teamMatchesFilter(team, roleById, filter))
    .sort((a, b) => compareTeams(a, b, sort));
}

function teamMatchesQuery(team: AuthzGroupDetail, directory: Directory, needle: string): boolean {
  if (needle.length === 0) return true;
  if (teamTitle(team.id).toLowerCase().includes(needle)) return true;
  return team.members.some((member) => {
    const party = lookupParty(directory, member.principalId);
    return party.name.toLowerCase().includes(needle) || party.detail.toLowerCase().includes(needle);
  });
}

function teamMatchesFilter(
  team: AuthzGroupDetail,
  roleById: Map<string, AuthzRole>,
  filter: TeamFilter
): boolean {
  if (filter === "no-access") return teamCapabilities(team, roleById).length === 0;
  if (filter === "empty") return team.members.length === 0;
  return true;
}

function compareTeams(a: AuthzGroupDetail, b: AuthzGroupDetail, sort: TeamSort): number {
  if (sort === "members-desc") return b.members.length - a.members.length || compareTeamNames(a, b);
  if (sort === "members-asc") return a.members.length - b.members.length || compareTeamNames(a, b);
  const byName = compareTeamNames(a, b);
  return sort === "name-desc" ? -byName : byName;
}

function compareTeamNames(a: AuthzGroupDetail, b: AuthzGroupDetail): number {
  return teamTitle(a.id).localeCompare(teamTitle(b.id));
}

function teamAccessSummary(team: AuthzGroupDetail, roleById: Map<string, AuthzRole>): string {
  if (team.roles.length === 0) return "No access yet.";
  const titles = team.roles.map((held) => {
    const role = roleById.get(held.roleId);
    return role ? summarizeRole(role).title : roleTitle(held.roleId);
  });
  const shown = titles.slice(0, 2).join(", ");
  const hidden = titles.length - 2;
  return hidden > 0 ? `${shown}, and ${hidden} more` : shown;
}

function memberCountLabel(count: number): string {
  if (count === 0) return "Nobody";
  return `${count} ${count === 1 ? "person" : "people"}`;
}

function teamCountLabel(count: number): string {
  return count === 1 ? "team" : "teams";
}

export function teamTitle(teamId: string): string {
  const words = teamId.replaceAll(/[._-]+/g, " ").trim();
  if (words.length === 0) return teamId;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * A name typed by a person, reduced to the identifier the API stores. Nobody should have to invent
 * a slug, but the slug is what collides, so the form shows the derived value and checks it.
 */
export function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");
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
    </div>
  );
}
