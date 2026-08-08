import type {
  GitHubContextResolver,
  GitHubEffectContext,
  GitHubInstallationScope,
} from "@tulipfarm/integrations";
import { GITHUB_REPOSITORY_TARGET, GITHUB_TOOL_IDS } from "@tulipfarm/integrations";
import type { AccessGrantDefinition } from "@tulipfarm/schema";
import type { ToolIntent } from "@tulipfarm/tool-broker";
import type { GitHubInstallationDirectory } from "./installation";

/**
 * Installation-scope-only authorization for chat's GitHub Tool calls, mirroring
 * `apps/worker/src/routine/github-context.ts` (a deliberate local copy — an application may not
 * import another application). No Soul-authored AccessGrant compilation exists yet, so this
 * resolver synthesizes an AccessGrant that trivially matches its own principal and exactly the one
 * repository the intent names; the real narrowing is `GitHubAdapter`'s installation-scope check.
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

function syntheticGrant(integrationId: string, repository: string): AccessGrantDefinition {
  return {
    apiVersion: "tulipfarm.ai/v1",
    kind: "AccessGrant",
    metadata: {
      id: "00000000-0000-4000-8000-000000000002",
      slug: "github-chat-installation-scope",
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
    const repository = repositoryArgument(intent);
    if (repository === undefined) return undefined;

    const installations = await this.installations.list();
    const matches = installations.filter((entry) => entry.repositories.includes(repository));
    if (matches.length === 0) return undefined;
    if (matches.length > 1) {
      this.log?.warn(
        { event: "github.context.ambiguous_installation", repository, count: matches.length },
        "multiple active GitHub installations list the same repository; refusing to guess"
      );
      return undefined;
    }
    const installation = matches[0];
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
}
