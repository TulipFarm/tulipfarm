import {
  type EntitlementAnswer,
  type EntitlementQuery,
  NOT_APPLICABLE,
  type ToolEntitlementPort,
} from "@tulipfarm/tool-broker";
import type { ExternalIdentityRepo } from "../identity/external-links";
import type { GitHubInstallationSelector } from "../tools/github/credentials";

/** A 404, which for a membership lookup is a verdict and not a failure. */
const NOT_FOUND = Symbol("github.not-found");

/** Every named account cleared — distinct from "GitHub could not tell us", which is `undefined`. */
const CLEARED = Symbol("github.organizations-cleared");

/** Ask GitHub whether the mapped user can access the repo; unclear answers deny. */

/** Must match `tools/github/tools.ts` resources or every check silently finds no repo. */
const GITHUB_TARGET_TYPE = "integration.github";
const REPO_PREFIX = "repo:";

/** What GitHub reports about one person's standing in one organization. */
export interface OrganizationStanding {
  /** An *active* member. A pending invitation is not membership and must read `false`. */
  readonly member: boolean;
  /** Whether this person may create a repository under the organization. */
  readonly canCreateRepositories: boolean;
}

/** Just enough of GitHub's REST surface to ask about one user's access to one thing. */
export interface GitHubPermissionApi {
  /** Repo permission verdict; `undefined` for transport or unparseable answers. */
  permissionFor(
    repository: string,
    username: string
  ): Promise<"admin" | "write" | "read" | "none" | undefined>;

  /** Org membership and repo-create verdict; `undefined` means deny rather than guess. */
  organizationStanding(
    organization: string,
    username: string
  ): Promise<OrganizationStanding | undefined>;
}

/** `org:` checks GitHub org membership/create policy; `installation:` falls through and denies. */
const ORGANIZATION_PREFIX = "org:";

/** Local installation listing is L5-exempt because it makes no provider call or content read. */
const DISCOVERY_ACTION = "github.repository.list";

/** Read actions need any access at all; anything else needs write. */
const READ_ACTIONS = new Set(["read", "list", "search", "get"]);

function actionKind(action: string): "read" | "write" {
  const verb = action.includes(".") ? (action.split(".").pop() ?? action) : action;
  return READ_ACTIONS.has(verb) ? "read" : "write";
}

/** Read repositories from the Tool's derived targets, never a second argument derivation. */
function idOf(ref: EntitlementQuery["targetRefs"][number]): string | undefined {
  if (ref.type !== GITHUB_TARGET_TYPE) return undefined;
  return typeof ref.id === "string" ? ref.id : undefined;
}

export function repositoriesIn(targetRefs: EntitlementQuery["targetRefs"]): string[] {
  const repos = new Set<string>();
  for (const ref of targetRefs) {
    if (ref.type !== GITHUB_TARGET_TYPE) continue;
    const id = ref.id;
    if (typeof id !== "string" || !id.startsWith(REPO_PREFIX)) continue;
    const repository = id.slice(REPO_PREFIX.length);
    // Only `owner/name` can be checked; wider targets yield nothing so access is undetermined.
    if (/^[^/]+\/[^/]+$/.test(repository)) repos.add(repository);
  }
  return [...repos].sort();
}

/** Account targets for repo creation; malformed names yield fail-closed no-targets. */
export function organizationsIn(targetRefs: EntitlementQuery["targetRefs"]): string[] {
  const orgs = new Set<string>();
  for (const ref of targetRefs) {
    const id = idOf(ref);
    if (id === undefined || !id.startsWith(ORGANIZATION_PREFIX)) continue;
    const owner = id.slice(ORGANIZATION_PREFIX.length);
    if (owner !== "" && !owner.includes("/")) orgs.add(owner);
  }
  return [...orgs].sort();
}

export class GitHubEntitlementPort implements ToolEntitlementPort {
  readonly provider = "github";

  constructor(
    private readonly identity: ExternalIdentityRepo,
    private readonly api: GitHubPermissionApi,
    private readonly now: () => Date = () => new Date()
  ) {}

  async check(query: EntitlementQuery): Promise<EntitlementAnswer> {
    // Only user principals have a GitHub account to ask; non-user callers rely on L1–L4 + scope.
    if (query.principal.kind !== "user") return NOT_APPLICABLE;

    if (query.action === DISCOVERY_ACTION) return NOT_APPLICABLE;

    const repositories = repositoriesIn(query.targetRefs);
    const organizations = organizationsIn(query.targetRefs);
    if (repositories.length === 0 && organizations.length === 0) {
      // Repo-less GitHub calls reach installation scope; refuse to guess.
      return undefined;
    }

    const username = await this.githubLogin(query.principal);
    if (username === undefined) {
      return {
        allowed: false,
        reason:
          "your GitHub account is not linked to this workspace, so GitHub cannot be asked what you have access to — link it from Settings › Integrations",
      };
    }

    const organizationAnswer = await this.checkOrganizations(organizations, username, query.action);
    if (organizationAnswer !== CLEARED) return organizationAnswer.answer;

    const needed = actionKind(query.action);
    for (const repository of repositories) {
      const permission = await this.api.permissionFor(repository, username);
      if (permission === undefined) return undefined;
      if (permission === "none") {
        return { allowed: false, reason: `you do not have access to ${repository} on GitHub` };
      }
      if (needed === "write" && permission === "read") {
        return { allowed: false, reason: `you have read-only access to ${repository} on GitHub` };
      }
    }
    return { allowed: true };
  }

  /** Return `CLEARED` only when every account cleared; `undefined` means unknown. */
  private async checkOrganizations(
    organizations: readonly string[],
    username: string,
    action: string
  ): Promise<{ readonly answer: EntitlementAnswer } | typeof CLEARED> {
    for (const organization of organizations) {
      // A caller's own login is their personal namespace; no org permission applies.
      if (organization.toLowerCase() === username.toLowerCase()) continue;

      const standing = await this.api.organizationStanding(organization, username);
      if (standing === undefined) return { answer: undefined };
      if (!standing.member) {
        return {
          answer: {
            allowed: false,
            reason: `you are not a member of the ${organization} organization on GitHub`,
          },
        };
      }
      if (actionKind(action) === "write" && !standing.canCreateRepositories) {
        return {
          answer: {
            allowed: false,
            reason: `${organization} does not allow you to create repositories on GitHub`,
          },
        };
      }
    }
    return CLEARED;
  }

  /** The GitHub login this principal is linked to, if the link is present and unexpired. */
  private async githubLogin(principal: EntitlementQuery["principal"]): Promise<string | undefined> {
    if (principal.kind !== "user") return undefined;
    const now = this.now().getTime();
    const mappings = await this.identity.listMappingsForUser(principal.id);
    for (const mapping of mappings) {
      if (mapping.provider !== "github") continue;
      if (mapping.expiresAt && mapping.expiresAt.getTime() <= now) continue;
      // The stored subject is GitHub's login where the link flow captured one.
      if (mapping.externalSubject !== "") return mapping.externalSubject;
    }
    return undefined;
  }
}

/** Ask GitHub with the covering installation token; all unparseable answers become `undefined`. */
export class HttpGitHubPermissionApi implements GitHubPermissionApi {
  constructor(
    private readonly token: (selector: GitHubInstallationSelector) => Promise<string | undefined>,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly baseUrl = "https://api.github.com"
  ) {}

  async permissionFor(
    repository: string,
    username: string
  ): Promise<"admin" | "write" | "read" | "none" | undefined> {
    const token = await this.token({ kind: "repository", repository });
    if (token === undefined) return undefined;

    let response: Response;
    try {
      response = await this.fetchImpl(
        `${this.baseUrl}/repos/${repository}/collaborators/${encodeURIComponent(username)}/permission`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
        }
      );
    } catch {
      return undefined;
    }

    // 403/404 means the installation was not told, not that GitHub returned a no-access verdict.
    if (!response.ok) return undefined;

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return undefined;
    }
    const permission = (body as { permission?: unknown } | null)?.permission;
    if (permission === "admin" || permission === "write" || permission === "read") {
      return permission;
    }
    // Only GitHub's `none` is a no-access verdict; unknown shapes stay undetermined.
    return permission === "none" ? "none" : undefined;
  }

  async organizationStanding(
    organization: string,
    username: string
  ): Promise<OrganizationStanding | undefined> {
    const token = await this.token({ kind: "account", owner: organization });
    if (token === undefined) return undefined;

    const membership = await this.getJson(
      token,
      `/orgs/${encodeURIComponent(organization)}/memberships/${encodeURIComponent(username)}`
    );
    // For org membership, only 404 is a negative verdict; other non-2xx results are undetermined.
    if (membership === NOT_FOUND) return { member: false, canCreateRepositories: false };
    if (membership === undefined) return undefined;

    const state = (membership as { state?: unknown }).state;
    // GitHub org role, not platform `role`; avoid looking like an admin gate.
    const orgRole = (membership as { role?: unknown }).role;
    // A pending invitation is not membership. Only `active` counts.
    if (state !== "active") return { member: false, canCreateRepositories: false };
    // Owners may create without reading an org policy endpoint the installation may not see.
    if (orgRole === "admin") return { member: true, canCreateRepositories: true };
    if (orgRole !== "member") return undefined;

    const org = await this.getJson(token, `/orgs/${encodeURIComponent(organization)}`);
    if (org === undefined || org === NOT_FOUND) return undefined;
    const policy = (org as { members_can_create_repositories?: unknown })
      .members_can_create_repositories;
    // A policy field we cannot read is not a permission. Absence must not be read as permission.
    if (typeof policy !== "boolean") return undefined;
    return { member: true, canCreateRepositories: policy };
  }

  /** The parsed body, `NOT_FOUND` for a 404, `undefined` for anything we cannot interpret. */
  private async getJson(token: string, path: string): Promise<unknown | typeof NOT_FOUND> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });
    } catch {
      return undefined;
    }
    if (response.status === 404) return NOT_FOUND;
    if (!response.ok) return undefined;
    try {
      return await response.json();
    } catch {
      return undefined;
    }
  }
}
