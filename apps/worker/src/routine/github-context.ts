import type {
  GitHubContextResolver,
  GitHubEffectContext,
  GitHubInstallationScope,
} from "@tulipfarm/integrations";
import {
  GITHUB_ORGANIZATION_TARGET,
  GITHUB_REPOSITORY_TARGET,
  GITHUB_TOOL_IDS,
} from "@tulipfarm/integrations";
import type { AccessGrantDefinition } from "@tulipfarm/schema";
import type { ToolIntent } from "@tulipfarm/tool-broker";
import { selectGitHubInstallation } from "./github-credentials";
import type { GitHubInstallationDirectory } from "./github-installation";

/**
 * Installation-scope-only authorization for GitHub Tool calls (Phase 3 decision): no Soul-authored
 * AccessGrant compilation exists yet, and `assertIntegrationAccess` hard-denies an empty grant
 * list, so this resolver synthesizes an AccessGrant that trivially matches its own principal and
 * exactly the one repository the intent names. The real narrowing — which repository, at which
 * permission level — is `GitHubAdapter`'s installation-scope check against Phase 2's stored scope;
 * this grant adds nothing beyond satisfying the shape the adapter also checks. Real Soul-authored
 * AccessGrants are a later phase, once PR contracts force the question concretely.
 */

const SYNTHETIC_PRINCIPAL: { readonly kind: "user" | "agent" | "role"; readonly id: string } = {
  kind: "role",
  id: "00000000-0000-4000-8000-000000000000",
};

const GITHUB_ACTIONS = Object.values(GITHUB_TOOL_IDS);

function repositoryArgument(intent: ToolIntent): string | undefined {
  const args = intent.arguments;
  if (args === null || typeof args !== "object" || Array.isArray(args)) return undefined;
  const repository = (args as Record<string, unknown>).repository;
  return typeof repository === "string" ? repository : undefined;
}

/** Repo creation has no `repository` argument yet — the repo doesn't exist — only `owner`. */
function ownerArgument(intent: ToolIntent): string | undefined {
  const args = intent.arguments;
  if (args === null || typeof args !== "object" || Array.isArray(args)) return undefined;
  const owner = (args as Record<string, unknown>).owner;
  return typeof owner === "string" ? owner : undefined;
}

function syntheticGrant(integrationId: string, repository: string): AccessGrantDefinition {
  return {
    apiVersion: "tulipfarm.ai/v1",
    kind: "AccessGrant",
    metadata: {
      id: "00000000-0000-4000-8000-000000000001",
      slug: "github-installation-scope",
      schemaVersion: 1,
      authoredVersion: 1,
      lifecycle: "active",
    },
    spec: {
      integrationId,
      principals: [SYNTHETIC_PRINCIPAL],
      actions: [...GITHUB_ACTIONS],
      externalTargets: [{ type: GITHUB_REPOSITORY_TARGET, ids: [repository] }],
      delegable: false,
    },
  };
}

function syntheticOrgGrant(integrationId: string, owner: string): AccessGrantDefinition {
  return {
    apiVersion: "tulipfarm.ai/v1",
    kind: "AccessGrant",
    metadata: {
      id: "00000000-0000-4000-8000-000000000004",
      slug: "github-installation-account-scope",
      schemaVersion: 1,
      authoredVersion: 1,
      lifecycle: "active",
    },
    spec: {
      integrationId,
      principals: [SYNTHETIC_PRINCIPAL],
      actions: [...GITHUB_ACTIONS],
      externalTargets: [{ type: GITHUB_ORGANIZATION_TARGET, ids: [owner] }],
      delegable: false,
    },
  };
}

/**
 * Resolves a Tool intent's repository against this business's active GitHub installations
 * (`GitHubInstallationDirectory`) and builds the scope + synthesized grant `GitHubAdapter` needs.
 * `undefined` when no installation covers the named repository — the adapter reports that as
 * `integration_context_unresolved`, never a guessed scope.
 */
export class InstallationScopeGitHubContextResolver implements GitHubContextResolver {
  constructor(
    private readonly businessId: string,
    private readonly installations: GitHubInstallationDirectory,
    private readonly log?: { warn: (obj: unknown, message?: string) => void }
  ) {}

  async resolve(intent: ToolIntent): Promise<GitHubEffectContext | undefined> {
    if (intent.action === GITHUB_TOOL_IDS.repositoryCreate) {
      return this.resolveForAccount(intent);
    }

    const repository = repositoryArgument(intent);
    if (repository === undefined) return undefined;

    // Two active installations both listing the same repository — a stale row from a reinstall, or
    // a transient org-transfer overlap — refuses here rather than guessing which token scope the
    // caller never chose. `selectGitHubInstallation` is the same matcher the credential provider
    // uses, so scope and credential can never resolve to different installations.
    const installation = selectGitHubInstallation(
      await this.installations.list(),
      { kind: "repository", repository },
      this.log
    );
    if (installation === undefined) return undefined;

    const scope: GitHubInstallationScope = {
      businessId: this.businessId,
      integrationId: installation.integrationId,
      installationId: installation.installationId,
      accountLogin: installation.accountLogin,
      repositories: installation.repositories,
      permissions: installation.permissions,
    };

    return {
      integrationId: installation.integrationId,
      installation: scope,
      principals: [SYNTHETIC_PRINCIPAL],
      grants: [syntheticGrant(installation.integrationId, repository)],
    };
  }

  /** Repo creation targets an account, not an existing repository — matched by `accountLogin`. */
  private async resolveForAccount(intent: ToolIntent): Promise<GitHubEffectContext | undefined> {
    const owner = ownerArgument(intent);
    if (owner === undefined) return undefined;

    const installation = selectGitHubInstallation(
      await this.installations.list(),
      { kind: "account", owner },
      this.log
    );
    if (installation === undefined) return undefined;

    const scope: GitHubInstallationScope = {
      businessId: this.businessId,
      integrationId: installation.integrationId,
      installationId: installation.installationId,
      accountLogin: installation.accountLogin,
      repositories: installation.repositories,
      permissions: installation.permissions,
    };

    return {
      integrationId: installation.integrationId,
      installation: scope,
      principals: [SYNTHETIC_PRINCIPAL],
      grants: [syntheticOrgGrant(installation.integrationId, owner)],
    };
  }
}
