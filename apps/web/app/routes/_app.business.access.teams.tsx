import {
  type ClientLoaderFunctionArgs,
  type MetaFunction,
  redirect,
  useLoaderData,
  useRouteError,
} from "@remix-run/react";
import { useMemo, useState } from "react";
import { FormStatus } from "~/components/form-status";
import { Search, Users } from "~/components/icons";
import { TeamAvatar } from "~/components/ui/avatar";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Field } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { Link } from "~/components/ui/link";
import { Panel } from "~/components/ui/panel";
import { Select } from "~/components/ui/select";
import { ApiError } from "~/lib/api";
import { listTeams, type TeamDirectoryEntry } from "~/lib/teams";
import { useIsAdmin } from "~/lib/use-session-user";
import { cn } from "~/lib/utils";

export const meta: MetaFunction = () => [{ title: "Teams · tulipfarm" }];

type TeamSort = "name-asc" | "name-desc" | "members-desc" | "members-asc";

export async function clientLoader({ request }: ClientLoaderFunctionArgs) {
  if (new URL(request.url).pathname !== "/teams") throw redirect("/teams");
  return listTeams();
}

export default function TeamsDirectory() {
  const { teams } = useLoaderData<typeof clientLoader>();
  const isAdmin = useIsAdmin();
  const [query, setQuery] = useState("");
  const [label, setLabel] = useState<string | null>(null);
  const [sort, setSort] = useState<TeamSort>("name-asc");
  const labels = useMemo(
    () =>
      [...new Set(teams.flatMap((team) => team.labels ?? []))].sort((a, b) => a.localeCompare(b)),
    [teams]
  );
  const visibleTeams = useMemo(
    () =>
      teams
        .filter((team) => matchesTeam(team, query, label))
        .sort((a, b) => compareTeams(a, b, sort)),
    [teams, query, label, sort]
  );

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-1">
        <p className="max-w-2xl text-sm text-muted-foreground">
          Group people and assets around the way your company actually works.
        </p>
      </div>

      <div className="flex flex-col gap-3 xl:flex-row xl:items-end xl:justify-between">
        <Field label="Search teams" className="w-full xl:max-w-xl">
          <div className="relative">
            <Search
              aria-hidden
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              type="search"
              aria-label="Search teams"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search by name, label, member, or slug"
              className="pl-9"
            />
          </div>
        </Field>
        <div className="flex items-end gap-2">
          <Field label="Sort" className="w-48">
            <Select value={sort} onChange={(event) => setSort(event.target.value as TeamSort)}>
              <option value="name-asc">Name A-Z</option>
              <option value="name-desc">Name Z-A</option>
              <option value="members-desc">Most members</option>
              <option value="members-asc">Fewest members</option>
            </Select>
          </Field>
          {isAdmin ? (
            <Button asChild className="active:scale-[0.96]">
              <Link to="/teams/new">Create Team</Link>
            </Button>
          ) : null}
        </div>
      </div>

      {labels.length > 0 ? (
        <fieldset className="flex flex-wrap items-center gap-2">
          <legend className="float-left mr-1 text-xs font-medium text-muted-foreground">
            Labels
          </legend>
          <LabelFilter label="All" selected={label === null} onClick={() => setLabel(null)} />
          {labels.map((item) => (
            <LabelFilter
              key={item}
              label={item}
              selected={label === item}
              onClick={() => setLabel(item)}
            />
          ))}
        </fieldset>
      ) : null}

      <p role="status" className="text-xs text-muted-foreground">
        {query.trim() || label
          ? `Showing ${visibleTeams.length} of ${teams.length} teams.`
          : `${teams.length} ${teams.length === 1 ? "team" : "teams"}.`}
      </p>

      <Panel
        title="All teams"
        description="Teams can own people, agents, skills, routines, files, and knowledge."
        flush
      >
        {teams.length === 0 ? (
          <DirectoryEmpty isAdmin={isAdmin} />
        ) : visibleTeams.length === 0 ? (
          <NoMatches
            query={query}
            label={label}
            onClear={() => {
              setQuery("");
              setLabel(null);
            }}
          />
        ) : (
          <TeamList teams={visibleTeams} allTeams={teams} />
        )}
      </Panel>
    </div>
  );
}

function LabelFilter({
  label,
  selected,
  onClick,
}: {
  label: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        "rounded-full border px-3 py-1 text-xs font-medium transition-colors duration-150 active:scale-[0.96]",
        selected
          ? "border-foreground bg-foreground text-background"
          : "border-border bg-card text-muted-foreground hover:border-foreground/30 hover:text-foreground"
      )}
    >
      {label}
    </button>
  );
}

function TeamList({
  teams,
  allTeams,
}: {
  teams: TeamDirectoryEntry[];
  allTeams: TeamDirectoryEntry[];
}) {
  const namesById = new Map(allTeams.map((team) => [team.id, team.displayName]));
  return (
    <ul aria-label="Teams" className="divide-y divide-border">
      {teams.map((team) => (
        <li key={team.id}>
          <Link
            to={`/teams/${encodeURIComponent(team.slug)}`}
            className="group grid gap-3 px-4 py-4 transition-colors duration-150 hover:bg-accent/50 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
          >
            <div className="flex min-w-0 items-start gap-3">
              <TeamAvatar identity={team.slug} className="size-10" />
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-foreground group-hover:underline">
                    {team.displayName}
                  </span>
                  {team.status === "archived" ? <Badge variant="neutral">Archived</Badge> : null}
                  {(team.labels ?? []).slice(0, 4).map((item) => (
                    <Badge key={item} variant="info">
                      {item}
                    </Badge>
                  ))}
                  {(team.labels?.length ?? 0) > 4 ? (
                    <Badge variant="neutral">+{(team.labels?.length ?? 0) - 4}</Badge>
                  ) : null}
                </div>
                <p className="mt-1 line-clamp-1 text-sm text-muted-foreground">
                  {team.description || "No description yet."}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {team.parentTeamId
                    ? `Inside ${namesById.get(team.parentTeamId) ?? "another Team"}`
                    : "Company-wide Team"}
                  <span aria-hidden> · </span>
                  <span className="font-mono">{team.slug}</span>
                </p>
              </div>
            </div>
            <div className="pl-[3.25rem] text-sm text-muted-foreground sm:pl-0 sm:text-right">
              <span className="font-medium text-foreground">{team.members.length}</span>{" "}
              {team.members.length === 1 ? "member" : "members"}
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function DirectoryEmpty({ isAdmin }: { isAdmin: boolean }) {
  return (
    <div className="flex min-h-64 flex-col items-center justify-center px-6 py-12 text-center">
      <div className="flex size-12 items-center justify-center rounded-2xl bg-brand/10 text-brand">
        <Users aria-hidden className="size-6" strokeWidth={2} />
      </div>
      <h2 className="mt-4 text-base font-semibold text-foreground">Build your first Team</h2>
      <p className="mt-1 max-w-md text-sm text-muted-foreground">
        Put people and the assets they use in one place. Access follows the Team automatically.
      </p>
      {isAdmin ? (
        <Button asChild className="mt-5 active:scale-[0.96]">
          <Link to="/teams/new">Create Team</Link>
        </Button>
      ) : null}
    </div>
  );
}

function NoMatches({
  query,
  label,
  onClear,
}: {
  query: string;
  label: string | null;
  onClear: () => void;
}) {
  return (
    <div className="flex min-h-52 flex-col items-center justify-center px-6 py-10 text-center">
      <div className="flex size-10 items-center justify-center rounded-xl bg-muted text-muted-foreground">
        <Search aria-hidden className="size-5" />
      </div>
      <h2 className="mt-3 text-sm font-semibold text-foreground">No Teams found</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {query.trim() ? `Nothing matches “${query.trim()}”.` : `No Teams use “${label}”.`}
      </p>
      <Button type="button" variant="outline" className="mt-4" onClick={onClear}>
        Clear filters
      </Button>
    </div>
  );
}

function matchesTeam(team: TeamDirectoryEntry, query: string, label: string | null): boolean {
  if (label && !(team.labels ?? []).includes(label)) return false;
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  return [
    team.displayName,
    team.slug,
    team.description ?? "",
    ...(team.labels ?? []),
    ...team.members.flatMap((member) => [
      member.name,
      member.level === "admin" ? `admin ${member.name}` : "",
    ]),
  ].some((value) => value.toLocaleLowerCase().includes(needle));
}

function compareTeams(a: TeamDirectoryEntry, b: TeamDirectoryEntry, sort: TeamSort): number {
  const byName = a.displayName.localeCompare(b.displayName);
  if (sort === "name-desc") return -byName;
  if (sort === "members-desc") return b.members.length - a.members.length || byName;
  if (sort === "members-asc") return a.members.length - b.members.length || byName;
  return byName;
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return "Could not load the Team directory.";
}

export function ErrorBoundary() {
  return <FormStatus tone="error">{errorMessage(useRouteError())}</FormStatus>;
}
