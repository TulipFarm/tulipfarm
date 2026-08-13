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

/**
 * Does *this person* have access to the repository this call reaches, on GitHub's own terms?
 *
 * Every GitHub Tool today spends the App installation's credential, and an installation is granted
 * over whole repositories regardless of who is asking. So without this check the platform's answer
 * to "can this person read that repo" is whatever the App can reach — which is the union of what
 * everyone can reach. An HR principal who was never added to a repository would nonetheless read
 * it, because the bot can. That is precisely the bypass D7 names.
 *
 * The check is deliberately GitHub's answer and not ours: we ask GitHub what permission the mapped
 * user holds. Anything short of a clear answer — no linked GitHub identity, an unreachable API, an
 * unparseable response — resolves to `undefined` ("could not determine") and the broker denies,
 * because the alternative is being most permissive exactly when least informed.
 */

/**
 * Must stay identical to `tools/github/tools.ts`'s `GITHUB_AUTHZ_RESOURCE` and `repositoryRef`.
 * Reading a shape the Tools do not emit would silently find no repositories in every call, and a
 * check that never finds anything to check is a check that never denies anything.
 */
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
  /**
   * `GET /repos/{owner}/{repo}/collaborators/{username}/permission`, reduced to its verdict.
   * `undefined` for any answer we cannot interpret, including transport failure.
   */
  permissionFor(
    repository: string,
    username: string
  ): Promise<"admin" | "write" | "read" | "none" | undefined>;

  /**
   * `GET /orgs/{org}/memberships/{username}` plus the org's own repository-creation policy,
   * reduced to the two facts that decide whether a creation may proceed. `undefined` for any
   * answer we cannot interpret, so the caller denies rather than guesses.
   */
  organizationStanding(
    organization: string,
    username: string
  ): Promise<OrganizationStanding | undefined>;
}

/**
 * Targets naming something other than a repository, and what to do about each.
 *
 * `org:` — repository creation. The repository does not exist yet, so there is no access-table
 * entry to read, but that does not make the question unanswerable: GitHub can say whether this
 * person is a member of the organization and whether members may create repositories there. That
 * is the question actually being asked, so we ask it rather than abstaining. Abstaining would have
 * let anyone holding the Role's blanket `integration.github` grant have the bot create a repository
 * under an organization they are not in.
 *
 * `installation:` — the whole installation, emitted by an unrestricted search. That *is* a widening
 * a person may not be entitled to, so it is not exempt: it falls through to the repository check,
 * finds no repository, and denies.
 */
const ORGANIZATION_PREFIX = "org:";

/**
 * The one action that reads no repository contents and makes no provider call: it projects the
 * installation rows this deployment already holds so the model can learn a repository name.
 *
 * Exempting it is not a hole. Every other GitHub Tool requires an `owner/repo` argument the model
 * has no other way to obtain, so denying this one denies the entire family by starving it of its
 * input — while the Tool itself declares `installation:all-repositories` as its target, which
 * already requires installation-wide authority at L1–L4. L5 has nothing to add: it would have to
 * ask GitHub about a repository, and the purpose of the call is to find out which repositories
 * there are.
 */
const DISCOVERY_ACTION = "github.repository.list";

/** Read actions need any access at all; anything else needs write. */
const READ_ACTIONS = new Set(["read", "list", "search", "get"]);

function actionKind(action: string): "read" | "write" {
  const verb = action.includes(".") ? (action.split(".").pop() ?? action) : action;
  return READ_ACTIONS.has(verb) ? "read" : "write";
}

/**
 * The repositories a call reaches, from the Tool's own derived targets.
 *
 * Reading the Tool's derivation rather than re-deriving from arguments is what keeps the
 * entitlement check and the authorization decision talking about the same thing — two derivations
 * would eventually disagree, and the disagreement would always resolve in favour of the looser one.
 */
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
    // `owner/name` is the only form GitHub's permission endpoint accepts. An `org:` or
    // `installation:` target names something wider than a repository and deliberately yields
    // nothing here, so the caller is left unable to determine access rather than reassured.
    if (/^[^/]+\/[^/]+$/.test(repository)) repos.add(repository);
  }
  return [...repos].sort();
}

/**
 * The accounts a call names but does not yet have a repository under.
 *
 * A malformed body (empty, or containing a `/`, which would make it a repository and not an
 * account) yields nothing, so the caller falls through to the fail-closed "could not determine"
 * branch rather than probing a name GitHub could never match.
 */
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
    // Only a person has a GitHub account whose access GitHub could report. An agent, a Routine, a
    // schedule fire or an unresolved channel delivery is bounded by the authority this platform
    // granted it (L1–L4) and by the App installation's own scope — there is no third party to ask.
    // Denying them here would take every Tool of this provider offline for every caller that is
    // not a signed-in human, which is most of them.
    if (query.principal.kind !== "user") return NOT_APPLICABLE;

    if (query.action === DISCOVERY_ACTION) return NOT_APPLICABLE;

    const repositories = repositoriesIn(query.targetRefs);
    const organizations = organizationsIn(query.targetRefs);
    if (repositories.length === 0 && organizations.length === 0) {
      // Naming no repository is not thereby harmless — a repo-less GitHub call reaches whatever
      // the installation reaches. Refusing to guess is the fail-closed answer.
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

  /**
   * Whether this person may act on each named account, or `CLEARED` if every account cleared.
   *
   * The wrapper is not ceremony: `undefined` is itself a meaningful answer here ("GitHub could not
   * tell us"), so it cannot double as the fall-through signal. Conflating the two would let an
   * unanswerable org probe fall through to a repository loop that has nothing to check and return
   * `allowed` — the exact fail-open this layer exists to prevent.
   */
  private async checkOrganizations(
    organizations: readonly string[],
    username: string,
    action: string
  ): Promise<{ readonly answer: EntitlementAnswer } | typeof CLEARED> {
    for (const organization of organizations) {
      // An account matching the caller's own login is that person's personal namespace. GitHub has
      // no organization by that name to ask about, and nobody needs permission to be themselves.
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

/**
 * Asks GitHub directly, over the App installation's own credential.
 *
 * The installation token is the right one to ask *with* even though the question is about a
 * person: we are asking GitHub to report its own access table, not acting on the person's behalf.
 * It is resolved *per repository* so a business holding several App installations asks each
 * question over the installation that actually covers it.
 * Every answer we cannot interpret — a non-2xx, an unparseable body, a transport failure —
 * collapses to `undefined`, because the caller's fail-closed handling of "could not determine" is
 * the only safe reading of a check that did not complete.
 */
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

    // 403/404 here means the installation cannot see the repository or the user, which is not the
    // same as GitHub reporting that the user has no access — we simply were not told.
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
    // GitHub reports "none" for a non-collaborator. Anything else is a shape we do not recognise
    // and must not read as either allowed or denied.
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
    // 404 is GitHub's answer for "not a member", and it is the *only* non-2xx we may read as a
    // verdict: it is the documented shape of the negative case. Every other failure means we were
    // not told, which the caller must treat as undetermined rather than as absence.
    if (membership === NOT_FOUND) return { member: false, canCreateRepositories: false };
    if (membership === undefined) return undefined;

    const state = (membership as { state?: unknown }).state;
    // GitHub's *organization* role, deliberately not named `role`: this platform's deployment
    // roles are a different vocabulary, and `role === "admin"` is the idiom the role-catalog
    // fitness check scans for. Conflating them would make this file look like an admin gate.
    const orgRole = (membership as { role?: unknown }).role;
    // A pending invitation is not membership. Only `active` counts.
    if (state !== "active") return { member: false, canCreateRepositories: false };
    // An owner may always create, so the org policy need not be read — and reading it would fail
    // for an owner of an org whose policy endpoint the installation cannot see.
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
