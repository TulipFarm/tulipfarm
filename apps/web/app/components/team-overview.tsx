import type { Team } from "@tulipfarm/schema";
import { type ReactNode, useEffect, useState } from "react";
import { OwnershipApprovalList } from "~/components/approvals/ownership-approval-list";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Link } from "~/components/ui/link";
import { Panel, PanelEmpty, PanelRow } from "~/components/ui/panel";
import { ApiError } from "~/lib/api";
import type {
  OwnershipApprovalPage,
  TeamActivityItem,
  TeamAssetSectionCatalog,
  TeamDirectoryEntry,
  TeamGrant,
  TeamMember,
  TeamRole,
} from "~/lib/teams";
import { listOwnershipApprovals } from "~/lib/teams";

type Loadable<T> = { ok: true; value: T } | { ok: false; message: string };

export function TeamOverview({
  team,
  directoryTeam,
  teams,
  members,
  authority,
  approvals,
  assets,
  activity,
  isBusinessAdmin,
  onChanged,
}: {
  team: Team;
  directoryTeam: TeamDirectoryEntry;
  teams: TeamDirectoryEntry[];
  members: Loadable<{ direct: TeamMember[]; inherited: TeamMember[] }>;
  authority: Loadable<{
    directRoles: TeamRole[];
    inheritedRoles: TeamRole[];
    directGrants: TeamGrant[];
    inheritedGrants: TeamGrant[];
  }>;
  approvals: Loadable<OwnershipApprovalPage>;
  assets: Loadable<TeamAssetSectionCatalog>;
  activity: Loadable<{ items: TeamActivityItem[]; nextCursor: string | null }>;
  isBusinessAdmin: boolean;
  onChanged: () => void;
}) {
  const teamById = new Map(teams.map((candidate) => [candidate.id, candidate]));
  const parent = team.parentTeamId ? teamById.get(team.parentTeamId) : undefined;
  const children = teams.filter((candidate) => candidate.parentTeamId === team.id);
  const admins = directoryTeam.members.filter((member) => member.level === "admin");
  const memberNames = new Map(
    teams.flatMap((candidate) =>
      candidate.members.map((member) => [member.principalId, member.name])
    )
  );
  const expiring = members.ok
    ? [...members.value.direct, ...members.value.inherited]
        .filter((member) => isSoon(member.expiresAt))
        .sort((a, b) => (a.expiresAt ?? "").localeCompare(b.expiresAt ?? ""))
    : [];
  const roles = authority.ok
    ? [...authority.value.directRoles, ...authority.value.inheritedRoles]
    : [];

  return (
    <div className="space-y-4">
      <Panel title="Team identity">
        <dl className="grid gap-4 sm:grid-cols-2">
          <ReadonlySummary label="Display name">{team.displayName}</ReadonlySummary>
          <ReadonlySummary label="Immutable slug">
            <code>{team.slug}</code>
          </ReadonlySummary>
          <ReadonlySummary label="Status">{team.status}</ReadonlySummary>
          <ReadonlySummary label="Description">
            {team.description || "No description"}
          </ReadonlySummary>
        </dl>
      </Panel>

      <div className="grid gap-4 xl:grid-cols-2">
        <Panel title="Hierarchy">
          <SummaryRow label="Parent">
            {parent ? <TeamLink team={parent} /> : "No parent"}
          </SummaryRow>
          <SummaryRow label="Child Teams">
            {children.length ? (
              <span className="flex flex-wrap justify-end gap-2">
                {children.map((child) => (
                  <TeamLink key={child.id} team={child} />
                ))}
              </span>
            ) : (
              "None"
            )}
          </SummaryRow>
        </Panel>

        <Panel title="People">
          <SummaryRow label="Team admins">
            {admins.length ? admins.map((admin) => admin.name).join(", ") : "None shown"}
          </SummaryRow>
          {members.ok ? (
            <>
              <SummaryRow label="Direct members">{members.value.direct.length}</SummaryRow>
              <SummaryRow label="Inherited members">{members.value.inherited.length}</SummaryRow>
            </>
          ) : (
            <Unavailable>Member counts are unavailable or restricted.</Unavailable>
          )}
        </Panel>
      </div>

      <Panel title="Assets" description="Assets connected to this Team by ownership or sharing.">
        <div className="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-border bg-border sm:grid-cols-5">
          {(
            [
              ["Agents", "agent"],
              ["Skills", "skill"],
              ["Routines", "routine"],
              ["Files", "file"],
              ["Knowledge", "knowledge"],
            ] as const
          ).map(([label, assetType]) => (
            <div key={assetType} className="bg-card p-3">
              <p className="text-xs text-muted-foreground">{label}</p>
              <p className="mt-1 text-sm font-medium">
                {assets.ok
                  ? assets.value.items.filter((item) => item.assetType === assetType).length
                  : "Unavailable"}
              </p>
            </div>
          ))}
        </div>
      </Panel>

      <div className="grid gap-4 xl:grid-cols-2">
        <Panel
          title="Key Roles"
          actions={<SummaryLink slug={team.slug} section="roles" label="View access" />}
        >
          {!authority.ok ? (
            <Unavailable>Role details are unavailable or restricted.</Unavailable>
          ) : roles.length === 0 ? (
            <PanelEmpty>No direct or inherited Roles.</PanelEmpty>
          ) : (
            roles.slice(0, 5).map((role) => (
              <PanelRow key={`${role.source}-${role.sourceTeamId}-${role.roleId}`}>
                <span className="text-sm">{role.roleId}</span>
                <Badge variant={role.source === "direct" ? "primary" : "neutral"}>
                  {role.source}
                </Badge>
              </PanelRow>
            ))
          )}
        </Panel>

        <Panel
          title="Expiring memberships"
          actions={<SummaryLink slug={team.slug} section="members" label="View members" />}
        >
          {!members.ok ? (
            <Unavailable>Membership expiry is unavailable or restricted.</Unavailable>
          ) : expiring.length === 0 ? (
            <PanelEmpty>No memberships expire in the next 30 days.</PanelEmpty>
          ) : (
            expiring.slice(0, 5).map((member) => (
              <PanelRow key={`${member.sourceTeamId}-${member.principalId}`}>
                <span className="text-sm">
                  {memberNames.get(member.principalId) ?? "Name unavailable"}
                </span>
                <time className="text-xs text-muted-foreground" dateTime={member.expiresAt ?? ""}>
                  {formatDate(member.expiresAt)}
                </time>
              </PanelRow>
            ))
          )}
        </Panel>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Panel title="Pending Approvals">
          <TeamApprovalPanel
            teamId={team.id}
            approvals={approvals}
            isBusinessAdmin={isBusinessAdmin}
            onChanged={onChanged}
          />
        </Panel>
        <Panel
          title="Recent Activity"
          actions={<SummaryLink slug={team.slug} section="activity" label="View Activity" />}
        >
          {!activity.ok ? (
            <Unavailable>Recent Activity is unavailable or restricted.</Unavailable>
          ) : activity.value.items.length === 0 ? (
            <PanelEmpty>No recent Team Activity.</PanelEmpty>
          ) : (
            activity.value.items.map((item) => (
              <PanelRow key={item.id}>
                <span className="min-w-0 text-sm">{item.summary}</span>
                <time className="shrink-0 text-xs text-muted-foreground" dateTime={item.createdAt}>
                  {formatDate(item.createdAt)}
                </time>
              </PanelRow>
            ))
          )}
        </Panel>
      </div>
    </div>
  );
}

function TeamApprovalPanel({
  teamId,
  approvals,
  isBusinessAdmin,
  onChanged,
}: {
  teamId: string;
  approvals: Loadable<OwnershipApprovalPage>;
  isBusinessAdmin: boolean;
  onChanged: () => void;
}) {
  const [page, setPage] = useState<OwnershipApprovalPage | null>(
    approvals.ok ? approvals.value : null
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setPage(approvals.ok ? approvals.value : null);
    setError(null);
  }, [approvals]);

  if (!approvals.ok || page === null) {
    return <Unavailable>Ownership Approvals are unavailable or restricted.</Unavailable>;
  }

  async function loadMore() {
    if (!page?.nextCursor) return;
    setLoading(true);
    setError(null);
    try {
      const next = await listOwnershipApprovals(teamId, {
        cursor: page.nextCursor,
        limit: 25,
      });
      setPage({
        items: [...page.items, ...next.items],
        nextCursor: next.nextCursor,
      });
    } catch (loadError) {
      setError(
        loadError instanceof ApiError ? loadError.message : "Could not load more Approvals."
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <OwnershipApprovalList
        approvals={page.items}
        isCompanyAdmin={isBusinessAdmin}
        onChanged={onChanged}
      />
      {error ? (
        <p role="alert" className="px-4 pb-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {page.nextCursor ? (
        <div className="border-border border-t p-3 text-center">
          <Button
            type="button"
            variant="outline"
            disabled={loading}
            onClick={() => void loadMore()}
          >
            {loading ? "Loading…" : "Load more Approvals"}
          </Button>
        </div>
      ) : null}
    </>
  );
}

export function TeamActivity({
  activity,
}: {
  activity: Loadable<{ items: TeamActivityItem[]; nextCursor: string | null }>;
}) {
  if (!activity.ok) {
    return (
      <Panel title="Team Activity">
        <Unavailable>Team Activity is unavailable or restricted.</Unavailable>
      </Panel>
    );
  }
  return (
    <Panel
      title="Team Activity"
      description="Authority, membership, hierarchy, sharing, and ownership changes."
    >
      {activity.value.items.length === 0 ? (
        <PanelEmpty>No Team Activity.</PanelEmpty>
      ) : (
        activity.value.items.map((item) => (
          <article
            key={item.id}
            className={
              item.emergency
                ? "border-status-danger border-l-4 bg-status-danger-surface p-3"
                : "border-border border-b p-3 last:border-b-0"
            }
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">{item.action}</span>
              <Badge variant={item.outcome === "succeeded" ? "success" : "danger"}>
                {item.outcome}
              </Badge>
              {item.emergency ? <Badge variant="danger">Emergency override</Badge> : null}
              <time className="ml-auto text-xs text-muted-foreground" dateTime={item.createdAt}>
                {formatDateTime(item.createdAt)}
              </time>
            </div>
            <dl className="mt-2 grid gap-2 text-xs sm:grid-cols-2">
              <ReadonlySummary label="Actor">{item.actorId ?? "System"}</ReadonlySummary>
              <ReadonlySummary label="Target">{item.target || "Team"}</ReadonlySummary>
              <ReadonlySummary label="Reason">
                {item.reason ?? "No reason supplied"}
              </ReadonlySummary>
            </dl>
          </article>
        ))
      )}
    </Panel>
  );
}

function ReadonlySummary({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-sm text-foreground">{children}</dd>
    </div>
  );
}

function SummaryRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <PanelRow>
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-right text-sm text-foreground">{children}</span>
    </PanelRow>
  );
}

function TeamLink({ team }: { team: TeamDirectoryEntry }) {
  return (
    <Link to={`/teams/${encodeURIComponent(team.slug)}`} className="hover:underline">
      {team.displayName}
    </Link>
  );
}

function SummaryLink({
  slug,
  section,
  label,
}: {
  slug: string;
  section: "members" | "roles" | "activity";
  label: string;
}) {
  return (
    <Link
      to={`/teams/${encodeURIComponent(slug)}?section=${section}`}
      className="text-sm text-muted-foreground hover:text-foreground"
    >
      {label}
    </Link>
  );
}

function Unavailable({ children }: { children: ReactNode }) {
  return <p className="p-4 text-sm text-muted-foreground">{children}</p>;
}

function isSoon(value: string | null): boolean {
  if (!value) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && time >= Date.now() && time <= Date.now() + 30 * 86_400_000;
}

function formatDate(value: string | null): string {
  if (!value) return "No expiry";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(value));
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
