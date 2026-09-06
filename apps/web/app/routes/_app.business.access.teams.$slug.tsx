import {
  type MetaFunction,
  redirect,
  useLoaderData,
  useRevalidator,
  useRouteError,
  useSearchParams,
} from "@remix-run/react";
import { TeamRolesAccess } from "~/components/access/team-roles-access";
import { FormStatus } from "~/components/form-status";
import { type TeamAssetSection, TeamAssetsPanel } from "~/components/team-assets-panel";
import { TeamLeaveAction, TeamMembers } from "~/components/team-members";
import { TeamActivity, TeamOverview } from "~/components/team-overview";
import { TeamSettings } from "~/components/team-settings";
import { TeamAvatar } from "~/components/ui/avatar";
import { Badge } from "~/components/ui/badge";
import { Link } from "~/components/ui/link";
import { listAgents } from "~/lib/agents";
import { ApiError } from "~/lib/api";
import { listRoles } from "~/lib/authz";
import {
  getTeam,
  getTeamActivity,
  getTeamAuthority,
  getTeamDelegationPolicy,
  getTeamMembers,
  listOwnershipApprovals,
  listServiceAccounts,
  listTeamAssets,
  listTeamHierarchy,
  listTeamLeaveRequests,
  listTeams,
} from "~/lib/teams";
import { useIsAdmin, useSessionUser } from "~/lib/use-session-user";
import { listUsers } from "~/lib/users";

export const meta: MetaFunction<typeof clientLoader> = ({ data }) => [
  { title: `${data?.team.displayName ?? "Team"} · Teams · tulipfarm` },
];

const SECTIONS = [
  ["overview", "Overview"],
  ["members", "Members"],
  ["agents", "Agents"],
  ["skills", "Skills"],
  ["routines", "Routines"],
  ["files", "Files"],
  ["knowledge", "Knowledge"],
  ["roles", "Roles & access"],
  ["activity", "Activity"],
  ["settings", "Settings"],
] as const;

type TeamSection = (typeof SECTIONS)[number][0];

export async function clientLoader({
  params,
  request,
}: {
  params: { slug?: string };
  request: Request;
}) {
  const url = new URL(request.url);
  if (url.pathname.startsWith("/business/access/teams/")) {
    throw redirect(`/teams/${encodeURIComponent(params.slug ?? "")}${url.search}`);
  }
  const [{ teams }, { teams: hierarchy }] = await Promise.all([listTeams(), listTeamHierarchy()]);
  const directoryTeam = teams.find((team) => team.slug === params.slug);
  if (!directoryTeam) throw new Response("Team not found", { status: 404 });
  const requestedSection = validSection(url.searchParams.get("section"));

  const [
    team,
    members,
    authority,
    activity,
    approvals,
    roles,
    policy,
    users,
    agents,
    services,
    leaveRequests,
    assets,
  ] = await Promise.all([
    getTeam(directoryTeam.id),
    settle(getTeamMembers(directoryTeam.id)),
    settle(getTeamAuthority(directoryTeam.id)),
    settle(getTeamActivity(directoryTeam.id)),
    settle(listOwnershipApprovals(directoryTeam.id)),
    settle(listRoles()),
    settle(getTeamDelegationPolicy(directoryTeam.id)),
    settle(listUsers()),
    settle(listAgents()),
    settle(listServiceAccounts()),
    settle(listTeamLeaveRequests(directoryTeam.id)),
    settle(
      listTeamAssets({
        teamId: directoryTeam.id,
        ...(isAssetSection(requestedSection)
          ? { type: assetTypeForSection(requestedSection) }
          : {}),
        limit: isAssetSection(requestedSection) ? 25 : 100,
      })
    ),
  ]);
  return {
    team,
    directoryTeam,
    teams,
    hierarchy,
    members,
    authority,
    activity,
    approvals,
    roles,
    policy,
    users,
    agents,
    services,
    leaveRequests,
    assets,
  };
}

export default function TeamDetailRoute() {
  const data = useLoaderData<typeof clientLoader>();
  const revalidator = useRevalidator();
  const [searchParams] = useSearchParams();
  const section = validSection(searchParams.get("section"));
  const sessionUser = useSessionUser();
  const isBusinessAdmin = useIsAdmin();
  const isTeamAdmin = data.directoryTeam.members.some(
    (member) => member.principalId === sessionUser?.id && member.level === "admin"
  );

  return (
    <div className="space-y-4">
      <div>
        <Link to="/teams" className="text-sm text-muted-foreground hover:text-foreground">
          ← Teams
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <TeamAvatar identity={data.team.slug} className="size-10" />
          <h2 className="text-lg font-semibold text-foreground">{data.team.displayName}</h2>
          {data.team.status === "archived" ? <Badge variant="neutral">Archived</Badge> : null}
          {(data.team.labels ?? []).map((label) => (
            <Badge key={label} variant="info">
              {label}
            </Badge>
          ))}
        </div>
        <p className="mt-1 font-mono text-xs text-muted-foreground">{data.team.slug}</p>
      </div>

      <div className="grid gap-4 lg:grid-cols-[11rem_minmax(0,1fr)]">
        <TeamSubnav slug={data.team.slug} section={section} />
        <main className="min-w-0">
          {section === "overview" ? (
            <TeamOverview
              team={data.team}
              directoryTeam={data.directoryTeam}
              teams={data.teams}
              members={data.members}
              authority={data.authority}
              approvals={data.approvals}
              assets={data.assets}
              activity={data.activity}
              isBusinessAdmin={isBusinessAdmin}
              onChanged={revalidator.revalidate}
            />
          ) : null}
          {section === "activity" ? <TeamActivity activity={data.activity} /> : null}
          {section === "settings" ? (
            <TeamSettings
              team={data.team}
              teams={data.teams}
              hierarchy={data.hierarchy}
              members={data.members}
              users={data.users}
              canEdit={isTeamAdmin}
              isBusinessAdmin={isBusinessAdmin}
              onChanged={revalidator.revalidate}
            />
          ) : null}
          {section === "members" ? (
            data.members.ok ? (
              <TeamMembers
                team={data.directoryTeam}
                teams={data.teams}
                members={data.members.value}
                users={data.users.ok ? data.users.value : []}
                agents={data.agents.ok ? data.agents.value : []}
                serviceAccounts={data.services.ok ? data.services.value : []}
                leaveRequests={data.leaveRequests.ok ? data.leaveRequests.value.requests : []}
                currentUserId={sessionUser?.id}
                canManage={isTeamAdmin || isBusinessAdmin}
                onChanged={revalidator.revalidate}
              />
            ) : (
              <div className="space-y-4">
                <section className="rounded-lg border border-border bg-card p-4">
                  <h2 className="text-sm font-medium">Members</h2>
                  <p className="mt-2 text-sm text-muted-foreground">
                    Membership details are unavailable or restricted.
                  </p>
                </section>
                {data.directoryTeam.members.some(
                  (member) => member.principalId === sessionUser?.id
                ) ? (
                  <TeamLeaveAction
                    teamId={data.team.id}
                    isFinalAdmin={
                      data.directoryTeam.members.filter((member) => member.level === "admin")
                        .length === 1 &&
                      data.directoryTeam.members.some(
                        (member) =>
                          member.principalId === sessionUser?.id && member.level === "admin"
                      )
                    }
                    onChanged={revalidator.revalidate}
                  />
                ) : null}
              </div>
            )
          ) : null}
          {section === "roles" ? (
            <TeamRolesAccess
              team={data.team}
              teams={data.teams}
              authority={data.authority}
              roles={data.roles}
              policy={data.policy}
              canManage={isTeamAdmin}
              isBusinessAdmin={isBusinessAdmin}
              onChanged={revalidator.revalidate}
            />
          ) : null}
          {isAssetSection(section) ? (
            <TeamAssetsPanel
              section={section}
              team={data.team}
              teams={data.teams}
              initialAssets={data.assets}
              canCreate={isTeamAdmin && data.team.status === "active"}
              isCompanyAdmin={isBusinessAdmin}
              onChanged={revalidator.revalidate}
            />
          ) : null}
        </main>
      </div>
    </div>
  );
}

function TeamSubnav({ slug, section }: { slug: string; section: TeamSection }) {
  return (
    <nav aria-label="Team sections">
      <ul className="grid grid-cols-2 gap-1 rounded-lg border border-border bg-card p-1 sm:grid-cols-3 lg:grid-cols-1">
        {SECTIONS.map(([value, label]) => (
          <li key={value}>
            <Link
              to={
                value === "overview"
                  ? `/teams/${encodeURIComponent(slug)}`
                  : `/teams/${encodeURIComponent(slug)}?section=${value}`
              }
              aria-current={section === value ? "page" : undefined}
              className={
                section === value
                  ? "block rounded-md bg-accent px-2.5 py-2 text-sm font-medium text-foreground"
                  : "block rounded-md px-2.5 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
              }
            >
              {label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function isAssetSection(section: TeamSection): section is TeamAssetSection {
  return ["agents", "skills", "routines", "files", "knowledge"].includes(section);
}

function assetTypeForSection(section: TeamAssetSection) {
  if (section === "agents") return "agent" as const;
  if (section === "skills") return "skill" as const;
  if (section === "routines") return "routine" as const;
  if (section === "files") return "file" as const;
  return "knowledge" as const;
}

function validSection(value: string | null): TeamSection {
  return SECTIONS.some(([section]) => section === value) ? (value as TeamSection) : "overview";
}

async function settle<T>(
  promise: Promise<T>
): Promise<{ ok: true; value: T } | { ok: false; message: string }> {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    return { ok: false, message: errorMessage(error, "Unavailable") };
  }
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

export function ErrorBoundary() {
  const error = useRouteError();
  const message =
    error instanceof Response && error.status === 404
      ? "This Team does not exist."
      : errorMessage(error, "Could not load this Team.");
  return <FormStatus tone="error">{message}</FormStatus>;
}
