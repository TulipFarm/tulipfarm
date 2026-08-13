import { NOT_APPLICABLE } from "@tulipfarm/tool-broker";
import { describe, expect, it } from "vitest";
import type { ExternalIdentityMappingDoc, ExternalIdentityRepo } from "../identity/external-links";
import { buildGitHubTools } from "../tools/github/tools";
import {
  GitHubEntitlementPort,
  type GitHubPermissionApi,
  HttpGitHubPermissionApi,
  type OrganizationStanding,
  organizationsIn,
  repositoriesIn,
} from "./github-entitlement";

type Permission = Awaited<ReturnType<GitHubPermissionApi["permissionFor"]>>;

function identity(mappings: readonly Partial<ExternalIdentityMappingDoc>[]): ExternalIdentityRepo {
  return {
    listMappingsForUser: async () =>
      mappings.map(
        (m) =>
          ({
            provider: "github",
            externalSubject: "dhruv",
            userId: "u1",
            ...m,
          }) as ExternalIdentityMappingDoc
      ),
  } as unknown as ExternalIdentityRepo;
}

function api(
  permissions: Record<string, Permission>,
  standings: Record<string, OrganizationStanding | undefined> = {}
): GitHubPermissionApi {
  return {
    permissionFor: async (repository) => permissions[repository],
    organizationStanding: async (organization) => standings[organization],
  };
}

/** A member of the org who may create repositories there. */
const CAN_CREATE: OrganizationStanding = { member: true, canCreateRepositories: true };

const REPO_TARGET = [{ type: "integration.github", id: "repo:acme/api" }];

function query(overrides: Record<string, unknown> = {}) {
  return {
    businessId: "biz-1",
    principal: { kind: "user", id: "u1" },
    provider: "github",
    action: "read",
    targetRefs: REPO_TARGET,
    ...overrides,
  };
}

/** Narrows away the two non-verdict answers so a test asserting a verdict cannot silently pass on
 * `not_applicable` or `undefined`. */
function verdictOf(answer: Awaited<ReturnType<GitHubEntitlementPort["check"]>>) {
  if (answer === undefined || answer === NOT_APPLICABLE) {
    throw new Error(`expected a verdict, got ${String(answer)}`);
  }
  return answer;
}

describe("repositoriesIn", () => {
  it("reads owner/name repositories out of the Tool's own derived targets", () => {
    expect(
      repositoriesIn([
        { type: "integration.github", id: "repo:acme/api" },
        { type: "integration.github", id: "repo:acme/web" },
        { type: "integration.slack", id: "channel:C1" },
      ])
    ).toEqual(["acme/api", "acme/web"]);
  });

  it("ignores a target that is not a resolvable repository", () => {
    // A wildcard or bare name cannot be checked against GitHub's permission endpoint, and treating
    // it as a repository would ask a question about the wrong thing and believe the answer.
    expect(
      repositoriesIn([
        { type: "integration.github", id: "installation:all" },
        { type: "integration.github", id: "org:acme" },
        { type: "integration.github", id: "" },
      ])
    ).toEqual([]);
  });
});

describe("GitHubEntitlementPort", () => {
  it("allows a read when GitHub says the person can read the repository", async () => {
    const p = new GitHubEntitlementPort(identity([{}]), api({ "acme/api": "read" }));
    expect(await p.check(query())).toEqual({ allowed: true });
  });

  it("denies a read when GitHub says the person has no access", async () => {
    const p = new GitHubEntitlementPort(identity([{}]), api({ "acme/api": "none" }));
    const verdict = verdictOf(await p.check(query()));
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain("acme/api");
  });

  it("denies a write to someone GitHub gives read-only access", async () => {
    // The case the campaign exists for: the App installation can write, so without this the
    // platform would let a read-only collaborator write through the bot.
    const p = new GitHubEntitlementPort(identity([{}]), api({ "acme/api": "read" }));
    const verdict = verdictOf(await p.check(query({ action: "create" })));
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain("read-only");
  });

  it("allows a write to a collaborator with write access", async () => {
    const p = new GitHubEntitlementPort(identity([{}]), api({ "acme/api": "write" }));
    expect(await p.check(query({ action: "create" }))).toEqual({ allowed: true });
  });

  it("requires every repository the call reaches, not just one of them", async () => {
    const p = new GitHubEntitlementPort(
      identity([{}]),
      api({ "acme/api": "write", "acme/secrets": "none" })
    );
    const verdict = await p.check(
      query({
        targetRefs: [
          { type: "integration.github", id: "repo:acme/api" },
          { type: "integration.github", id: "repo:acme/secrets" },
        ],
      })
    );
    expect(verdictOf(verdict).allowed).toBe(false);
  });

  it("denies an HR principal with no linked GitHub identity, and says how to fix it", async () => {
    const p = new GitHubEntitlementPort(identity([]), api({ "acme/api": "write" }));
    const verdict = verdictOf(await p.check(query()));
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain("link");
  });

  it("ignores an expired identity link", async () => {
    const p = new GitHubEntitlementPort(
      identity([{ expiresAt: new Date("2020-01-01T00:00:00Z") }]),
      api({ "acme/api": "write" }),
      () => new Date("2026-01-01T00:00:00Z")
    );
    expect(verdictOf(await p.check(query())).allowed).toBe(false);
  });

  it("could-not-determine when GitHub gives no interpretable answer", async () => {
    const p = new GitHubEntitlementPort(identity([{}]), api({}));
    expect(await p.check(query())).toBeUndefined();
  });

  it("could-not-determine when the call names no repository at all", async () => {
    // A repo-less GitHub call reaches whatever the installation reaches, so there is nothing
    // narrower to check and no basis on which to allow it.
    const p = new GitHubEntitlementPort(identity([{}]), api({ "acme/api": "write" }));
    expect(await p.check(query({ targetRefs: [] }))).toBeUndefined();
  });

  it("could-not-determine for an installation-wide search, which is a real widening", async () => {
    const p = new GitHubEntitlementPort(identity([{}]), api({ "acme/api": "write" }));
    const answer = await p.check(
      query({
        action: "github.issue.search",
        targetRefs: [{ type: "integration.github", id: "installation:__all__" }],
      })
    );
    expect(answer).toBeUndefined();
  });

  /*
   * L5 answers "does *this person* hold provider-side access". Where there is no person, there is
   * no question — and answering `undefined` (deny) instead would take every GitHub Tool offline for
   * every caller that is not a signed-in human: Routines, schedule fires, and every Slack or
   * Telegram turn, which arrive as `integration` because no human has been resolved at ingress
   * (`runtime/invocation-callers.ts`).
   */
  it("abstains for principals that are not people, rather than denying them", async () => {
    const p = new GitHubEntitlementPort(identity([{}]), api({ "acme/api": "write" }));
    for (const kind of ["routine", "agent", "service", "integration_adapter", "api"]) {
      expect(await p.check(query({ principal: { kind, id: "x" } }))).toBe(NOT_APPLICABLE);
    }
  });

  /*
   * The discovery Tool makes no provider call and reads no repository contents — it projects the
   * installation rows this deployment already holds. Every other GitHub Tool requires an
   * `owner/repo` argument the model has no other way to learn, so denying this one denies the
   * whole family by starving it of its input.
   */
  it("abstains for the local repository-discovery projection", async () => {
    const p = new GitHubEntitlementPort(identity([{}]), api({ "acme/api": "write" }));
    const answer = await p.check(
      query({
        action: "github.repository.list",
        targetRefs: [{ type: "integration.github", id: "installation:all-repositories" }],
      })
    );
    expect(answer).toBe(NOT_APPLICABLE);
  });

  /*
   * Repository creation names an account under which the repository does not exist yet. That makes
   * the *repository* unanswerable, not the question — GitHub can say whether this person is in the
   * organization and whether members there may create repositories. Abstaining would have let
   * anyone holding the Role's blanket `integration.github` grant have the bot create a repository
   * under an organization they are not in.
   */
  const createQuery = (owner = "acme") =>
    query({
      action: "github.repository.create",
      targetRefs: [{ type: "integration.github", id: `org:${owner}` }],
    });

  it("allows a member whose organization lets members create repositories", async () => {
    const p = new GitHubEntitlementPort(identity([{}]), api({}, { acme: CAN_CREATE }));
    expect(verdictOf(await p.check(createQuery())).allowed).toBe(true);
  });

  it("denies creation under an organization the person is not a member of", async () => {
    const p = new GitHubEntitlementPort(
      identity([{}]),
      api({}, { acme: { member: false, canCreateRepositories: false } })
    );
    const verdict = verdictOf(await p.check(createQuery()));
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain("not a member of the acme organization");
  });

  it("denies a member whose organization reserves repository creation", async () => {
    const p = new GitHubEntitlementPort(
      identity([{}]),
      api({}, { acme: { member: true, canCreateRepositories: false } })
    );
    const verdict = verdictOf(await p.check(createQuery()));
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain("does not allow you to create repositories");
  });

  it("cannot determine when GitHub does not answer about the organization", async () => {
    const p = new GitHubEntitlementPort(identity([{}]), api({}, {}));
    // `undefined` is the fail-closed answer the broker turns into a denial. It must not be
    // NOT_APPLICABLE, which would waive the layer entirely.
    expect(await p.check(createQuery())).toBeUndefined();
  });

  it("needs no organization membership to create under the person's own account", async () => {
    // GitHub has no organization named `dhruv` to ask about, and nobody needs permission to be
    // themselves. The probe must not be called at all.
    let asked = 0;
    const p = new GitHubEntitlementPort(identity([{}]), {
      permissionFor: async () => undefined,
      organizationStanding: async () => {
        asked += 1;
        return undefined;
      },
    });
    expect(verdictOf(await p.check(createQuery("Dhruv"))).allowed).toBe(true);
    expect(asked).toBe(0);
  });

  it("refuses an organization target when the person has no linked GitHub account", async () => {
    const p = new GitHubEntitlementPort(identity([]), api({}, { acme: CAN_CREATE }));
    const verdict = verdictOf(await p.check(createQuery()));
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain("not linked");
  });

  it("still denies a person on a repository they lack, with an org target also present", async () => {
    const p = new GitHubEntitlementPort(
      identity([{}]),
      api({ "acme/api": "none" }, { acme: CAN_CREATE })
    );
    const verdict = verdictOf(
      await p.check(
        query({
          targetRefs: [
            { type: "integration.github", id: "org:acme" },
            { type: "integration.github", id: "repo:acme/api" },
          ],
        })
      )
    );
    expect(verdict.allowed).toBe(false);
  });
});

/*
 * Drift guard. `repositoriesIn` reads a target shape the GitHub Tools produce; nothing in the type
 * system ties the two together, and a rename on either side would leave this port quietly finding
 * no repositories in any call — an entitlement check that never finds anything to check never
 * denies anything, and would look exactly like one that passes.
 */
describe("organizationsIn", () => {
  it("reads accounts out of org targets and ignores everything else", () => {
    expect(
      organizationsIn([
        { type: "integration.github", id: "org:acme" },
        { type: "integration.github", id: "repo:acme/api" },
        { type: "integration.github", id: "installation:all-repositories" },
        { type: "integration.slack", id: "org:acme" },
      ])
    ).toEqual(["acme"]);
  });

  it("yields nothing for a malformed account, so the caller cannot determine access", () => {
    // A body containing a slash is a repository, not an account, and an empty one names nothing.
    // Either would make the probe ask GitHub about a name it could never match, and a 404 there
    // reads as "not a member" — a verdict we have no right to draw from our own malformed input.
    expect(
      organizationsIn([
        { type: "integration.github", id: "org:" },
        { type: "integration.github", id: "org:acme/api" },
      ])
    ).toEqual([]);
  });
});

describe("agreement with the GitHub Tools' own derivation", () => {
  it("reads the repository out of what the real Tools actually derive", () => {
    const tools = buildGitHubTools("biz-1", {
      installations: { list: async () => [] },
      effects: undefined,
    } as unknown as Parameters<typeof buildGitHubTools>[1]);

    const withRepoArg = tools.filter(
      (tool) =>
        tool.definition !== undefined &&
        JSON.stringify(tool.definition.inputSchema).includes('"repository"')
    );
    expect(withRepoArg.length).toBeGreaterThan(0);

    for (const tool of withRepoArg) {
      const derived = tool.definition?.targetsFor({ repository: "acme/api" }, undefined) ?? [];
      // Not every repository-taking Tool derives a repository target (a create names an org), but
      // no Tool may derive one this port cannot read back.
      const repos = repositoriesIn(derived);
      const namesARepo = derived.some((ref) => String(ref.id ?? "").startsWith("repo:"));
      expect(repos.length > 0).toBe(namesARepo);
    }
  });

  it("declines to read an installation-wide target as a repository", () => {
    // `searchRepositoryTargets` emits `installation:*` when the call searches everything. Treating
    // that as a repository would ask GitHub about a repo named `*` and believe the answer.
    expect(repositoriesIn([{ type: "integration.github", id: "installation:__all__" }])).toEqual(
      []
    );
  });
});

/*
 * The production probe. Its job is to turn GitHub's several shapes of "no" into exactly one of
 * three answers, and the distinction that matters most is between a 404 on a membership lookup
 * (GitHub telling us this person is not a member) and every other failure (GitHub telling us
 * nothing). Reading the second as the first would deny honestly; reading the first as the second
 * would deny too, but reading *anything* as membership would open the hole this port closes.
 */
describe("HttpGitHubPermissionApi.organizationStanding", () => {
  type Route = { status: number; body?: unknown };

  function http(routes: Record<string, Route>, { uninstalled = false } = {}) {
    const seen: string[] = [];
    const fetchImpl = (async (url: string) => {
      const path = String(url).replace("https://api.github.com", "");
      seen.push(path);
      const route = routes[path];
      if (route === undefined) return { ok: false, status: 500, json: async () => ({}) };
      return {
        ok: route.status >= 200 && route.status < 300,
        status: route.status,
        json: async () => {
          if (route.body === undefined) throw new Error("not json");
          return route.body;
        },
      };
    }) as unknown as typeof fetch;
    const api = new HttpGitHubPermissionApi(
      async () => (uninstalled ? undefined : "ghs_1"),
      fetchImpl
    );
    return { api, seen };
  }

  const MEMBERSHIP = "/orgs/acme/memberships/dhruv";
  const ORG = "/orgs/acme";

  it("allows an owner without reading the organization's member policy", async () => {
    const { api, seen } = http({
      [MEMBERSHIP]: { status: 200, body: { state: "active", role: "admin" } },
    });
    expect(await api.organizationStanding("acme", "dhruv")).toEqual({
      member: true,
      canCreateRepositories: true,
    });
    // An owner may always create, and the policy endpoint may be unreachable for the installation.
    expect(seen).toEqual([MEMBERSHIP]);
  });

  it("reads the organization's policy for an ordinary member", async () => {
    const { api } = http({
      [MEMBERSHIP]: { status: 200, body: { state: "active", role: "member" } },
      [ORG]: { status: 200, body: { members_can_create_repositories: false } },
    });
    expect(await api.organizationStanding("acme", "dhruv")).toEqual({
      member: true,
      canCreateRepositories: false,
    });
  });

  it("reads a 404 membership as GitHub's own answer that the person is not a member", async () => {
    const { api } = http({ [MEMBERSHIP]: { status: 404, body: {} } });
    expect(await api.organizationStanding("acme", "dhruv")).toEqual({
      member: false,
      canCreateRepositories: false,
    });
  });

  it("treats a pending invitation as not membership", async () => {
    const { api } = http({
      [MEMBERSHIP]: { status: 200, body: { state: "pending", role: "admin" } },
    });
    expect(await api.organizationStanding("acme", "dhruv")).toEqual({
      member: false,
      canCreateRepositories: false,
    });
  });

  it.each([
    ["a 403 the installation cannot see past", { [MEMBERSHIP]: { status: 403, body: {} } }],
    ["an unparseable membership body", { [MEMBERSHIP]: { status: 200 } }],
    [
      "a role we do not recognise",
      { [MEMBERSHIP]: { status: 200, body: { state: "active", role: "billing_manager" } } },
    ],
    [
      "an organization whose policy field is missing",
      {
        [MEMBERSHIP]: { status: 200, body: { state: "active", role: "member" } },
        [ORG]: { status: 200, body: {} },
      },
    ],
    [
      "an organization lookup that 404s",
      {
        [MEMBERSHIP]: { status: 200, body: { state: "active", role: "member" } },
        [ORG]: { status: 404, body: {} },
      },
    ],
  ])("cannot determine from %s", async (_label, routes) => {
    const { api } = http(routes as Record<string, Route>);
    expect(await api.organizationStanding("acme", "dhruv")).toBeUndefined();
  });

  it("cannot determine when no installation covers the account", async () => {
    const { api, seen } = http({}, { uninstalled: true });
    expect(await api.organizationStanding("acme", "dhruv")).toBeUndefined();
    expect(seen).toEqual([]);
  });

  it("cannot determine when the request itself throws", async () => {
    const api = new HttpGitHubPermissionApi(async () => "ghs_1", (() => {
      throw new Error("network down");
    }) as unknown as typeof fetch);
    expect(await api.organizationStanding("acme", "dhruv")).toBeUndefined();
  });
});
