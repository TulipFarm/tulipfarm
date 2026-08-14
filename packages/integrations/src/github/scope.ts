import { assertExternalIdentityMapped, type ExternalIdentityMapping } from "@tulipfarm/authz";

/** GitHub installation scope is the outer bound; AccessGrants may only narrow it. */

export interface GitHubRepositoryRef {
  readonly owner: string;
  readonly repo: string;
}

export type GitHubPermissionLevel = "read" | "write";

export interface GitHubInstallationScope {
  readonly businessId: string;
  readonly integrationId: string;
  readonly installationId: string;
  /** Owning account (user or org) the App was installed on. */
  readonly accountLogin: string;
  /** Selected repositories as `owner/repo`, or `"all"` for an account-wide installation. */
  readonly repositories: readonly string[] | "all";
  readonly permissions: Readonly<Record<string, GitHubPermissionLevel>>;
}

export type GitHubScopeDenialReason =
  | "malformed_repository_ref"
  | "installation_unknown"
  | "account_out_of_scope"
  | "repository_out_of_scope"
  | "permission_missing"
  | "permission_insufficient";

export class GitHubScopeDeniedError extends Error {
  readonly name = "GitHubScopeDeniedError";

  constructor(readonly reason: GitHubScopeDenialReason) {
    super(`github_scope_denied:${reason}`);
  }
}

const REPOSITORY_REF = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/;

export function parseRepositoryRef(ref: string): GitHubRepositoryRef {
  const match = REPOSITORY_REF.exec(ref);
  if (match === null) throw new GitHubScopeDeniedError("malformed_repository_ref");
  return { owner: match[1] as string, repo: match[2] as string };
}

export function repositoryRef(target: GitHubRepositoryRef): string {
  return `${target.owner}/${target.repo}`;
}

export interface GitHubPermissionNeed {
  /** GitHub permission name, e.g. `issues`, `contents`, `metadata`. */
  readonly permission: string;
  readonly level: GitHubPermissionLevel;
}

/** Throws unless `scope` covers `target` at the required permission level. */
export function assertRepositoryInScope(
  scope: GitHubInstallationScope | undefined,
  target: GitHubRepositoryRef,
  need: GitHubPermissionNeed
): asserts scope is GitHubInstallationScope {
  if (scope === undefined) throw new GitHubScopeDeniedError("installation_unknown");

  // An account-wide installation is still bounded by the account it was installed on: a
  // same-named repository under a different owner is a different repository.
  if (target.owner !== scope.accountLogin) {
    throw new GitHubScopeDeniedError("account_out_of_scope");
  }
  if (scope.repositories !== "all" && !scope.repositories.includes(repositoryRef(target))) {
    throw new GitHubScopeDeniedError("repository_out_of_scope");
  }

  const held = scope.permissions[need.permission];
  if (held === undefined) throw new GitHubScopeDeniedError("permission_missing");
  if (need.level === "write" && held !== "write") {
    throw new GitHubScopeDeniedError("permission_insufficient");
  }
}

/** Authorize account-level actions whose target repo does not exist yet. */
export function assertAccountInScope(
  scope: GitHubInstallationScope | undefined,
  owner: string,
  need: GitHubPermissionNeed
): asserts scope is GitHubInstallationScope {
  if (scope === undefined) throw new GitHubScopeDeniedError("installation_unknown");

  if (owner !== scope.accountLogin) {
    throw new GitHubScopeDeniedError("account_out_of_scope");
  }

  const held = scope.permissions[need.permission];
  if (held === undefined) throw new GitHubScopeDeniedError("permission_missing");
  if (need.level === "write" && held !== "write") {
    throw new GitHubScopeDeniedError("permission_insufficient");
  }
}

/** Provider-qualified subject for a GitHub user id, as stored on the identity mapping. */
export function githubExternalSubject(externalId: string): string {
  return `github:user:${externalId}`;
}

/**
 * Resolve a GitHub sender to the TulipFarm principal it is verifiably mapped to. An unmapped,
 * cross-business, or expired mapping denies — an external actor never inherits a default identity.
 */
export function resolveGitHubActor(
  mapping: ExternalIdentityMapping | undefined,
  businessId: string,
  now: Date
): string {
  assertExternalIdentityMapped(mapping, businessId, now);
  return mapping.principalId;
}
