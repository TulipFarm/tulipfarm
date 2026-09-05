import { type MetaFunction, useLoaderData, useRouteError } from "@remix-run/react";
import { AccessTabs } from "~/components/access-tabs";
import { FormStatus } from "~/components/form-status";
import { Badge } from "~/components/ui/badge";
import { Link } from "~/components/ui/link";
import { Panel, PanelEmpty } from "~/components/ui/panel";
import { getTeamMigrationReport, type TeamMigrationReportItem } from "~/lib/admin";
import { ApiError } from "~/lib/api";

export const meta: MetaFunction = () => [{ title: "Team migration report · tulipfarm" }];

export async function clientLoader() {
  return getTeamMigrationReport();
}

export default function TeamMigrationReportRoute() {
  const { items } = useLoaderData<typeof clientLoader>();

  return (
    <div className="space-y-4">
      <AccessTabs />
      <Link to="/teams" className="inline-flex text-sm text-muted-foreground hover:text-foreground">
        ← Teams
      </Link>
      <Panel
        title="Team migration conflicts"
        description="Legacy groups with names or slugs that needed a distinct Team during migration."
        flush
        footer={
          items.length > 0 ? (
            <p className="text-sm text-muted-foreground">
              Review each generated Team. You can update its display name, but its slug is
              immutable.
            </p>
          ) : undefined
        }
      >
        {items.length === 0 ? (
          <PanelEmpty>No Team migration conflicts</PanelEmpty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-border border-b text-muted-foreground text-xs">
                <tr>
                  <th className="px-4 py-2 font-medium">Conflict</th>
                  <th className="px-4 py-2 font-medium">Legacy identifier/name</th>
                  <th className="px-4 py-2 font-medium">Generated Team</th>
                  <th className="px-4 py-2 font-medium">Resolution</th>
                  <th className="px-4 py-2 font-medium">
                    <span className="sr-only">Action</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {items.map((item) => (
                  <MigrationRow key={item.teamId} item={item} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}

function MigrationRow({ item }: { item: TeamMigrationReportItem }) {
  return (
    <tr>
      <td className="px-4 py-3 align-top">{conflictKind(item)}</td>
      <td className="px-4 py-3 align-top">
        <code className="text-xs">{item.legacyGroupId}</code>
      </td>
      <td className="px-4 py-3 align-top">
        <p className="font-medium text-foreground">{item.displayName}</p>
        <code className="text-xs text-muted-foreground">{item.teamSlug}</code>
      </td>
      <td className="px-4 py-3 align-top">
        <Badge variant="success">Resolved</Badge>
        <p className="mt-1 text-xs text-muted-foreground">Migrated {formatDate(item.migratedAt)}</p>
      </td>
      <td className="px-4 py-3 text-right align-top">
        <Link
          to={`/teams/${encodeURIComponent(item.teamSlug)}`}
          className="whitespace-nowrap text-sm font-medium hover:underline"
        >
          Review Team
        </Link>
      </td>
    </tr>
  );
}

function conflictKind(item: TeamMigrationReportItem): string {
  if (item.slugConflict && item.siblingNameConflict) return "Slug and sibling name";
  if (item.slugConflict) return "Slug";
  if (item.siblingNameConflict) return "Sibling name";
  return "Unknown conflict";
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
}

export function ErrorBoundary() {
  const error = useRouteError();
  const message =
    error instanceof ApiError && error.status === 403
      ? "Only a company admin can view the Team migration report."
      : error instanceof ApiError
        ? error.message
        : "Could not load the Team migration report.";
  return <FormStatus tone="error">{message}</FormStatus>;
}
