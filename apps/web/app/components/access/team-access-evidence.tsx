import type { TeamAccessExplanation } from "@tulipfarm/schema";
import { Badge } from "~/components/ui/badge";
import { Link } from "~/components/ui/link";
import type { TeamDirectoryEntry } from "~/lib/teams";

export function TeamAccessEvidence({
  explanation,
  teams,
}: {
  explanation: TeamAccessExplanation;
  teams: readonly TeamDirectoryEntry[];
}) {
  const teamById = new Map(teams.map((team) => [team.id, team]));

  return (
    <section aria-labelledby="team-access-evidence" className="rounded-md border border-border">
      <div className="border-b border-border px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 id="team-access-evidence" className="text-sm font-medium text-foreground">
            Why this access?
          </h2>
          <Badge variant={explanation.allowed ? "success" : "danger"}>
            {explanation.allowed ? "Allowed" : "Denied"}
          </Badge>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">{explanation.reason}</p>
      </div>
      {explanation.evidence.length === 0 ? (
        <p className="p-3 text-sm text-muted-foreground">
          No Team membership, Role, or grant matched this check.
        </p>
      ) : (
        <ol className="divide-y divide-border">
          {explanation.evidence.map((item, index) => (
            <li
              key={`${item.kind}:${item.sourceTeamId ?? ""}:${item.roleId ?? ""}:${item.grantId ?? ""}:${index}`}
              className="space-y-1 px-3 py-2"
            >
              <div className="flex flex-wrap items-center gap-2">
                <Badge
                  variant={
                    item.effect === "deny"
                      ? "danger"
                      : item.effect === "allow"
                        ? "success"
                        : "neutral"
                  }
                >
                  {evidenceLabel(item.kind)}
                </Badge>
                {item.roleId ? <code className="text-xs">{item.roleId}</code> : null}
                {item.grantId ? <code className="text-xs">Grant {item.grantId}</code> : null}
                {item.authorityLayer ? (
                  <span className="text-xs text-muted-foreground">Layer {item.authorityLayer}</span>
                ) : null}
              </div>
              {item.sourceTeamId ? (
                <p className="text-xs text-muted-foreground">
                  Source Team: <TeamEvidenceLink team={teamById.get(item.sourceTeamId)} />
                </p>
              ) : null}
              {item.pathTeamIds ? (
                <p className="text-xs text-muted-foreground">
                  Membership path:{" "}
                  {item.pathTeamIds.map((teamId, pathIndex) => (
                    <span key={teamId}>
                      {pathIndex > 0 ? " → " : ""}
                      <TeamEvidenceLink team={teamById.get(teamId)} fallback={teamId} />
                    </span>
                  ))}
                </p>
              ) : null}
              {item.expiresAt ? (
                <p className="text-xs text-muted-foreground">
                  Expires {new Date(item.expiresAt).toLocaleString()}
                </p>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function TeamEvidenceLink({ team, fallback }: { team?: TeamDirectoryEntry; fallback?: string }) {
  if (!team) return <span>{fallback ?? "Unknown Team"}</span>;
  return (
    <Link to={`/teams/${encodeURIComponent(team.slug)}`} className="hover:underline">
      {team.displayName}
    </Link>
  );
}

function evidenceLabel(kind: TeamAccessExplanation["evidence"][number]["kind"]): string {
  return {
    direct_membership: "Direct membership",
    inherited_membership: "Inherited membership",
    team_ancestry: "Team ancestry",
    role: "Role",
    grant: "Grant",
    explicit_deny: "Deny source",
    expiry: "Expiry",
    authority_layer: "Authority layer",
  }[kind];
}
