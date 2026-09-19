import type { McpAccountSummary } from "@tulipfarm/schema";
import { useEffect, useState } from "react";
import { Button } from "~/components/ui/button";
import { Link } from "~/components/ui/link";
import {
  grantMcpAccount,
  listMcpAccountGrants,
  type McpAccountGrantSummary,
  revokeMcpAccountGrant,
} from "~/lib/mcp-accounts";
import { listRoutines } from "~/lib/routines";
import { listTeams } from "~/lib/teams";
import { listUsers } from "~/lib/users";
import { IntegrationChoice } from "./integration-choice";
import { McpError, McpField } from "./mcp-form";

type GrantKind = "user" | "team" | "routine";
type SubjectOption = { id: string; label: string; href?: string };
type GrantData = {
  grants: McpAccountGrantSummary[];
  subjects: Record<GrantKind, SubjectOption[]>;
};

export function McpAccountGrants({ account }: { account: McpAccountSummary }) {
  const [data, setData] = useState<GrantData>();
  const [kind, setKind] = useState<GrantKind>("user");
  const [subjectId, setSubjectId] = useState("");
  const [error, setError] = useState<unknown>();
  const [pending, setPending] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [notice, setNotice] = useState("");

  // biome-ignore lint/correctness/useExhaustiveDependencies: A persisted grant change reloads its directory and current grants.
  useEffect(() => {
    let live = true;
    setData(undefined);
    setError(undefined);
    Promise.all([
      listMcpAccountGrants(account.integrationKey, account.id),
      listUsers(),
      listTeams(),
      listRoutines(),
    ])
      .then(([grants, users, teams, routines]) => {
        if (!live) return;
        setData({
          grants,
          subjects: {
            user: users
              .filter((user) => user.status === "active")
              .map((user) => ({
                id: user.id,
                label: user.name ? `${user.name} · ${user.email}` : user.email,
              })),
            team: teams.teams
              .filter((team) => team.status === "active")
              .map((team) => ({ id: team.id, label: `${team.displayName} · ${team.slug}` })),
            routine: routines.map((routine) => ({
              id: routine.id,
              label: `${routine.displayName ?? routine.slug} · ${routine.slug}`,
              href: `/routines/${encodeURIComponent(routine.slug)}`,
            })),
          },
        });
      })
      .catch((cause) => {
        if (live) setError(cause);
      });
    return () => {
      live = false;
    };
  }, [account.integrationKey, account.id, attempt]);

  async function mutate(action: () => Promise<unknown>, success: string) {
    setPending(true);
    setError(undefined);
    setNotice("");
    try {
      await action();
      setNotice(success);
      setSubjectId("");
      setAttempt((value) => value + 1);
    } catch (cause) {
      setError(cause);
    } finally {
      setPending(false);
    }
  }
  const selected = data?.subjects[kind].find((subject) => subject.id === subjectId);
  return (
    <div className="space-y-3 rounded-md border border-border p-3">
      <h4 className="text-sm font-medium">Who can use this shared account?</h4>
      <p className="text-xs text-muted-foreground">
        Grant people or Teams access to choose this account in Chat. They must still confirm shared
        use, and Tool permissions still apply. Each Routine needs separate approval bound to its
        current instructions, Agent, Tools, account and output destination. Material edits
        invalidate that approval.
      </p>
      <McpError error={error} />
      {!data ? (
        error ? (
          <Button size="sm" variant="outline" onClick={() => setAttempt((value) => value + 1)}>
            Retry grants
          </Button>
        ) : (
          <p role="status" className="text-xs text-muted-foreground">
            Loading access and available people, Teams and Routines...
          </p>
        )
      ) : (
        <>
          <ul className="divide-y divide-border">
            {data.grants.map((grant) => {
              const options =
                grant.subject.kind === "knowledge_sync" ? [] : data.subjects[grant.subject.kind];
              const subject = options.find((item) => item.id === grant.subject.id);
              const materialBound =
                grant.subject.kind === "routine" || grant.subject.kind === "knowledge_sync";
              return (
                <li
                  key={`${grant.subject.kind}:${grant.subject.id}`}
                  className="flex flex-wrap items-center gap-2 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <p className="break-words text-sm">
                      {grant.subject.kind === "team"
                        ? "Team"
                        : grant.subject.kind === "routine"
                          ? "Routine"
                          : grant.subject.kind === "knowledge_sync"
                            ? "Knowledge sync"
                            : "User"}{" "}
                      · {subject?.label ?? grant.subject.id}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {grant.status === "stale" || grant.accountRevision !== account.revision
                        ? "Account or configuration changed; fresh approval required."
                        : materialBound
                          ? "Configuration-bound approval. Current configuration is checked before every use."
                          : "Account-use grant; source and Tool permissions still apply."}
                    </p>
                  </div>
                  {subject?.href && (
                    <Link to={subject.href} className="text-xs text-brand hover:underline">
                      Review Routine
                    </Link>
                  )}
                  {grant.subject.kind === "routine" && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={pending}
                      onClick={() =>
                        void mutate(
                          () =>
                            grantMcpAccount(account.integrationKey, account.id, {
                              kind: "routine",
                              id: grant.subject.id,
                            }),
                          "Current Routine configuration approved."
                        )
                      }
                    >
                      Approve current configuration
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={pending}
                    onClick={() =>
                      void mutate(
                        () =>
                          revokeMcpAccountGrant(account.integrationKey, account.id, grant.subject),
                        "Grant revoked."
                      )
                    }
                  >
                    Revoke
                  </Button>
                </li>
              );
            })}
          </ul>
          {data.grants.length === 0 && (
            <p className="text-xs text-muted-foreground">
              No one has been granted shared access yet.
            </p>
          )}
          <form
            className="max-w-xl space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              void mutate(
                () => grantMcpAccount(account.integrationKey, account.id, { kind, id: subjectId }),
                kind === "routine"
                  ? "Current Routine configuration approved."
                  : "Shared account access granted."
              );
            }}
          >
            <fieldset disabled={pending} className="space-y-3">
              <McpField label="Grant access to">
                <IntegrationChoice
                  label="Grant access to"
                  value={kind}
                  options={[
                    { value: "user", label: "User — interactive Chat" },
                    { value: "team", label: "Team — interactive Chat" },
                    { value: "routine", label: "Routine — separate configuration approval" },
                  ]}
                  onChange={(value) => {
                    if (value === "user" || value === "team" || value === "routine") {
                      setKind(value);
                      setSubjectId("");
                    }
                  }}
                />
              </McpField>
              <McpField label={kind === "team" ? "Team" : kind === "routine" ? "Routine" : "User"}>
                <IntegrationChoice
                  label="Grant recipient"
                  value={subjectId}
                  options={data.subjects[kind].map((subject) => ({
                    value: subject.id,
                    label: subject.label,
                  }))}
                  onChange={setSubjectId}
                />
              </McpField>
              {selected?.href && (
                <Link to={selected.href} className="text-xs text-brand hover:underline">
                  Review Routine before approval
                </Link>
              )}
              <Button type="submit" disabled={!subjectId}>
                {kind === "routine" ? "Approve Routine account use" : "Grant shared account use"}
              </Button>
            </fieldset>
          </form>
        </>
      )}
      {notice && (
        <p role="status" className="text-xs text-muted-foreground">
          {notice}
        </p>
      )}
    </div>
  );
}
