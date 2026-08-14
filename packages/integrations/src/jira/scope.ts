import { assertExternalIdentityMapped, type ExternalIdentityMapping } from "@tulipfarm/authz";

/** Jira site scope is the outer bound; AccessGrants may only narrow it. */

export interface JiraIssueKey {
  readonly projectKey: string;
  readonly number: number;
}

export type JiraPermissionLevel = "read" | "write";

export interface JiraSiteScope {
  readonly businessId: string;
  readonly integrationId: string;
  readonly cloudId: string;
  readonly siteUrl: string;
  /** Project keys the Integration covers, or `"all"` for a site-wide installation. */
  readonly projects: readonly string[] | "all";
  readonly permissions: Readonly<Record<string, JiraPermissionLevel>>;
}

export type JiraScopeDenialReason =
  | "malformed_issue_key"
  | "site_unknown"
  | "project_out_of_scope"
  | "permission_missing"
  | "permission_insufficient";

export class JiraScopeDeniedError extends Error {
  readonly name = "JiraScopeDeniedError";

  constructor(readonly reason: JiraScopeDenialReason) {
    super(`jira_scope_denied:${reason}`);
  }
}

const ISSUE_KEY = /^([A-Z][A-Z0-9]*)-([1-9][0-9]*)$/;

export function parseIssueKey(key: string): JiraIssueKey {
  const match = ISSUE_KEY.exec(key);
  if (match === null) throw new JiraScopeDeniedError("malformed_issue_key");
  return { projectKey: match[1] as string, number: Number(match[2]) };
}

export interface JiraPermissionNeed {
  readonly permission: string;
  readonly level: JiraPermissionLevel;
}

export function assertProjectInScope(
  scope: JiraSiteScope | undefined,
  projectKey: string,
  need: JiraPermissionNeed
): asserts scope is JiraSiteScope {
  if (scope === undefined) throw new JiraScopeDeniedError("site_unknown");
  if (scope.projects !== "all" && !scope.projects.includes(projectKey)) {
    throw new JiraScopeDeniedError("project_out_of_scope");
  }

  const held = scope.permissions[need.permission];
  if (held === undefined) throw new JiraScopeDeniedError("permission_missing");
  if (need.level === "write" && held !== "write") {
    throw new JiraScopeDeniedError("permission_insufficient");
  }
}

/** Browse URL for an issue on the installed site. */
export function jiraIssueUrl(scope: JiraSiteScope, issueKey: string): string {
  return `${scope.siteUrl}/browse/${issueKey}`;
}

/** Provider-qualified subject for an Atlassian account id. */
export function jiraExternalSubject(accountId: string): string {
  return `jira:user:${accountId}`;
}

/** Resolve a Jira account to the principal it is verifiably mapped to, or deny. */
export function resolveJiraActor(
  mapping: ExternalIdentityMapping | undefined,
  businessId: string,
  now: Date
): string {
  assertExternalIdentityMapped(mapping, businessId, now);
  return mapping.principalId;
}
