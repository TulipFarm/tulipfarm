import { createHash } from "node:crypto";
import {
  GITHUB_REPOSITORY_LIST_DECLARATION,
  GITHUB_TOOL_CONTRACTS,
  GITHUB_TOOL_DECLARATIONS,
  GITHUB_TOOL_IDS,
  type GitHubToolId,
} from "@tulipfarm/integrations";
import type { MutationGuard } from "@tulipfarm/observability";
import {
  EffectDispatcher,
  type EffectStore,
  intentDigest,
  normalizeToolIntent,
  ToolCatalog,
  ToolDispatchError,
  type ToolIntent,
  type ToolTargetRef,
} from "@tulipfarm/tool-broker";
import {
  defineApiTool,
  err,
  ok,
  type RequestContext,
  type ToolCallResult,
  type ToolDef,
  toToolDef,
} from "@tulipfarm/tool-host";
import type { GitHubTooling } from "./compose";
import {
  type GitHubInstallationSelector,
  githubInstallationSecretRef,
  githubPersonalSecretRef,
} from "./credentials";

/** Chat GitHub Tools use the effect-ledger path; approval stays the chat mutating gate. */

const GITHUB_CATALOG = ToolCatalog.load(GITHUB_TOOL_CONTRACTS);
const GITHUB_ALL_REPOSITORIES_TARGET_ID = "all-repositories";
const GITHUB_RESOURCE = "integration.github";

/**
 * Tool ids whose repeat is a second real GitHub event, not a reproduction of existing state
 * (#646). Read tools and idempotent-in-effect mutations (label/assign/close on an already-set
 * value) are deliberately excluded, so the Tool loop's ordinary repeat-and-self-correct behavior
 * still applies to them.
 */
const GITHUB_SIDE_EFFECTING_TOOL_IDS = new Set<string>([
  GITHUB_TOOL_IDS.issueCreate,
  GITHUB_TOOL_IDS.issueComment,
  GITHUB_TOOL_IDS.pullRequestCreate,
  GITHUB_TOOL_IDS.pullRequestComment,
  GITHUB_TOOL_IDS.pullRequestReview,
  GITHUB_TOOL_IDS.pullRequestMerge,
  GITHUB_TOOL_IDS.repoPush,
  GITHUB_TOOL_IDS.repositoryCreate,
]);

/** Dresses a digest as an RFC 4122 v4 uuid for durable effect ids. */
function derivedId(...parts: readonly string[]): string {
  const digest = createHash("sha256").update(parts.join(":")).digest("hex");
  const version = `4${digest.slice(13, 16)}`;
  const variant = ((Number.parseInt(digest.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    version,
    `${variant}${digest.slice(17, 20)}`,
    digest.slice(20, 32),
  ].join("-");
}

function mapDispatchError(error: ToolDispatchError, toolId: GitHubToolId): ToolCallResult {
  if (error.code === "invalid_output")
    return err("internal_error", "GitHub returned an unexpected response shape");
  if (error.detail === "integration_context_unresolved") {
    return err(
      "not_found",
      "No active GitHub installation covers that repository. Call github_repository_list to see " +
        "which repositories are installed, then retry with one of those."
    );
  }
  // Credential denial means no unique covering installation, or the GitHub App cannot mint tokens.
  if (error.detail === "credential_denied") {
    return err(
      "not_found",
      "No active GitHub installation could supply a credential for that repository. Call " +
        "github_repository_list to see which repositories are installed, then retry with one " +
        "of those."
    );
  }
  if (error.detail === "installation_scope_denied" && toolId === GITHUB_TOOL_IDS.repositoryCreate) {
    return err(
      "not_found",
      "Creating this repository needs the GitHub App's administration:write permission, which " +
        "isn't granted by default. Ask an org admin to upgrade the App's permissions from its " +
        "GitHub installation settings page, then retry."
    );
  }
  // Retry budget is spent; classify provider transient failures as infrastructure, not bad args.
  if (error.detail === "provider_rate_limited" || error.detail === "provider_unavailable") {
    return err("unavailable", `GitHub is temporarily unavailable; try again shortly.`);
  }
  return err("internal_error", error.detail ? `${error.code}:${error.detail}` : error.message);
}

/** Replayed effect: `confirmed` is success without repeating; no response body is retained. */
function replayed(state: string): ToolCallResult {
  switch (state) {
    case "confirmed":
      return ok({ replayed: true, note: "This action already completed; not repeated." });
    case "denied":
      return err("internal_error", "effect_denied");
    case "failed":
      return err("internal_error", "effect_failed");
    default:
      return err("internal_error", `effect_${state}`);
  }
}

function recordArgs(args: unknown): Record<string, unknown> {
  return args !== null && typeof args === "object" && !Array.isArray(args)
    ? (args as Record<string, unknown>)
    : {};
}

function stringValue(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Derived targets use Tool grant namespace; provider identity moves into the selector id. */
const GITHUB_AUTHZ_RESOURCE = "integration.github";

const repositoryRef = (id: string) => ({ type: GITHUB_AUTHZ_RESOURCE, id: `repo:${id}` });

function repositoryTargets(args: unknown): readonly ToolTargetRef[] {
  const source = recordArgs(args);
  const repository = stringValue(source, "repository");
  return repository === undefined ? [] : [repositoryRef(repository)];
}

function allRepositoriesTarget(): readonly ToolTargetRef[] {
  // This is deliberately not "*": grant matching treats "*" as a grant-side wildcard sentinel.
  return [{ type: GITHUB_AUTHZ_RESOURCE, id: `installation:${GITHUB_ALL_REPOSITORIES_TARGET_ID}` }];
}

function repositoryCreateTargets(args: unknown): readonly ToolTargetRef[] {
  const owner = stringValue(recordArgs(args), "owner");
  return owner === undefined ? [] : [{ type: GITHUB_AUTHZ_RESOURCE, id: `org:${owner}` }];
}

/** Resolve the installation credential that covers the Tool's explicit target. */
function githubCredentialSelector(toolId: GitHubToolId, args: unknown): GitHubInstallationSelector {
  const source = recordArgs(args);
  if (toolId === GITHUB_TOOL_IDS.repositoryCreate) {
    const owner = stringValue(source, "owner");
    return owner === undefined ? { kind: "any" } : { kind: "account", owner };
  }
  const repository = stringValue(source, "repository");
  if (repository !== undefined) return { kind: "repository", repository };

  return { kind: "any" };
}

function githubTargets(toolId: GitHubToolId, args: unknown): readonly ToolTargetRef[] {
  if (toolId === GITHUB_TOOL_IDS.repositoryCreate) return repositoryCreateTargets(args);
  return repositoryTargets(args);
}

function buildToolDef(
  toolId: GitHubToolId,
  businessId: string,
  tooling: GitHubToolingContext
): ToolDef {
  const declaration = GITHUB_TOOL_DECLARATIONS.find((candidate) => candidate.toolId === toolId);
  if (declaration === undefined) {
    throw new Error(`github tool declaration not published: ${toolId}`);
  }
  const contract = GITHUB_CATALOG.get(toolId, declaration.toolVersion);
  if (contract === undefined) {
    throw new Error(`github tool contract not published: ${toolId}`);
  }

  const definition = defineApiTool<RequestContext>({
    name: declaration.name,
    tier: "integration",
    mutating: contract.mutating,
    // Repeated with identical arguments, each of these files a second real GitHub event rather
    // than reproducing existing state (#646): a second issue, comment, merge, or repository.
    ...(GITHUB_SIDE_EFFECTING_TOOL_IDS.has(toolId) ? { sideEffecting: true } : {}),
    description: declaration.description,
    inputSchema: contract.inputSchema,
    outputSchema: contract.outputSchema,
    authorization: {
      action: contract.action,
      resources: [GITHUB_RESOURCE],
      targets: (args) => githubTargets(toolId, args),
      dataClasses: contract.dataClasses,
      allowedDestinations: contract.allowedDestinations,
    },
    riskClass: contract.riskClass,
    credentialMode: "user_preferred",
    provider: "github",
    idempotency: contract.idempotency.strategy,
    retry: contract.retry,
    timeout: contract.timeout,
    compensation: contract.compensation,
    version: contract.toolVersion,
    async handler(args, ctx): Promise<ToolCallResult> {
      const runId = ctx.runId;
      if (runId === undefined) return err("internal_error", "no run context for this tool call");
      // Without a call id, idempotency lasts only for this direct call, not crash/replay.
      const callId = ctx.toolCallId ?? crypto.randomUUID();
      const stateId = `invoke:${callId}`;

      const rawIntent: ToolIntent = {
        intentId: derivedId("github-intent", runId, stateId, toolId),
        businessId,
        runId,
        stateId,
        toolId,
        toolVersion: contract.toolVersion,
        action: toolId,
        // Build intent from `targetsFor`; the gate reads the same derivation.
        targetRefs: definition.targetsFor(args, ctx),
        arguments: args,
        credentialRef:
          ctx.credentialPrincipal === undefined
            ? githubInstallationSecretRef(githubCredentialSelector(toolId, args))
            : githubPersonalSecretRef(ctx.credentialPrincipal),
        idempotencyKey: derivedId("github-idempotency", runId, stateId, toolId),
      };
      const intent = normalizeToolIntent(rawIntent);
      const effectId = derivedId("github-effect", runId, stateId, toolId);

      const reserved = await tooling.effects.reserve({
        effectId,
        businessId,
        runId,
        stateId,
        logicalEffectOrdinal: 0,
        idempotencyKey: intent.idempotencyKey,
        intentDigest: intentDigest(intent),
        intent,
        guardrailRevision: ctx.guardrailRevision ?? "none",
        createdAt: new Date().toISOString(),
      });

      if (reserved.outcome === "duplicate") return replayed(reserved.effect.state);

      const dispatcher = new EffectDispatcher({
        store: tooling.effects,
        catalog: GITHUB_CATALOG,
        adapters: tooling.adapters,
        credentialDispatcher: tooling.credentials,
        ...(tooling.mutationGuard === undefined
          ? {}
          : {
              mutationGuard: tooling.mutationGuard,
              mutationIdentity: { integrationId: "github" },
            }),
      });

      try {
        const output = await dispatcher.dispatch(
          businessId,
          reserved.effect.effectId,
          ctx.abortSignal
        );
        return ok(output);
      } catch (error) {
        if (error instanceof ToolDispatchError) return mapDispatchError(error, toolId);
        throw error;
      }
    },
  });

  return toToolDef(definition, (ctx) => ctx);
}

export const GITHUB_REPOSITORY_LIST_TOOL_NAME = GITHUB_REPOSITORY_LIST_DECLARATION.name;

/** Local-only repository discovery; no GitHub API call or effect ledger reservation. */
function buildRepositoryListTool(tooling: GitHubTooling): ToolDef {
  const definition = defineApiTool<RequestContext>({
    name: GITHUB_REPOSITORY_LIST_TOOL_NAME,
    tier: "integration",
    mutating: false,
    description: GITHUB_REPOSITORY_LIST_DECLARATION.description,
    inputSchema: GITHUB_REPOSITORY_LIST_DECLARATION.inputSchema,
    authorization: {
      action: "github.repository.list",
      resources: [GITHUB_RESOURCE],
      // A catalog of which repositories are installed, not the contents of any of them.
      dataClasses: ["directory"],
      // Listing enumerates every installed repository, so require installation-wide authority.
      targets: allRepositoriesTarget,
    },
    credentialMode: "service",
    provider: "github",
    idempotency: "none",
    async handler(): Promise<ToolCallResult> {
      const installations = await tooling.installations.list();
      const repositories = installations.flatMap((installation) =>
        installation.repositories.map((repository) => ({
          repository,
          account: installation.accountLogin,
          permissions: installation.permissions,
        }))
      );
      return ok({ repositories });
    },
  });

  return toToolDef(definition, (ctx) => ctx);
}

export interface GitHubToolingContext extends GitHubTooling {
  readonly effects: EffectStore;
  readonly mutationGuard?: MutationGuard;
}

export function buildGitHubTools(businessId: string, tooling: GitHubToolingContext): ToolDef[] {
  return [
    buildRepositoryListTool(tooling),
    ...GITHUB_TOOL_DECLARATIONS.map((declaration) =>
      buildToolDef(declaration.toolId, businessId, tooling)
    ),
  ];
}

/** GitHub chat tool names, computable without live tooling composition. */
export const GITHUB_TOOL_NAMES: ReadonlySet<string> = new Set([
  GITHUB_REPOSITORY_LIST_TOOL_NAME,
  ...GITHUB_TOOL_DECLARATIONS.map((declaration) => declaration.name),
]);
