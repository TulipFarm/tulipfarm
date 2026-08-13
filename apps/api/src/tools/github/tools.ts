import { createHash } from "node:crypto";
import {
  GITHUB_ORGANIZATION_TARGET,
  GITHUB_REPOSITORY_TARGET,
  GITHUB_TOOL_CONTRACTS,
  GITHUB_TOOL_IDS,
  type GitHubToolId,
} from "@tulipfarm/integrations";
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
import { defineApiTool, toToolDef } from "../define";
import { err, ok, type RequestContext, type ToolCallResult, type ToolDef } from "../types";
import type { GitHubTooling } from "./compose";
import { type GitHubInstallationSelector, githubInstallationSecretRef } from "./credentials";

/**
 * The chat-facing GitHub Tool family — one `ToolDef` per `GITHUB_TOOL_CONTRACTS` entry, tier
 * `"integration"`. Every call goes through the same effect-ledger idempotency path a Routine's
 * `tool` State uses (`EffectStore.reserve` -> `EffectDispatcher.dispatch`), so a crash mid-call
 * never double-posts a comment or double-merges a PR. Approval gating is the existing chat-turn
 * coarse gate (`RegistryToolDispatcher.needsApproval`, keyed on `ToolDef.mutating`) — this family
 * does not re-derive a Broker-catalog/GuardrailPolicy authorization decision the way a Routine's
 * `tool` State does, per the scope decision in `docs/plans/2026-08-07-github-chat-tool-access.md`.
 */

const GITHUB_CATALOG = ToolCatalog.load(GITHUB_TOOL_CONTRACTS);
const GITHUB_INSTALLATION_TARGET = "github.installation";
const GITHUB_ALL_REPOSITORIES_TARGET_ID = "all-repositories";
const GITHUB_RESOURCE = "integration.github";

interface GitHubToolSpec {
  readonly name: string;
  readonly description: string;
}

const GITHUB_TOOL_SPECS: Record<GitHubToolId, GitHubToolSpec> = {
  [GITHUB_TOOL_IDS.issueRead]: {
    name: "github_issue_read",
    description: "Read one GitHub issue's title, body, state, labels, and assignees.",
  },
  [GITHUB_TOOL_IDS.issueSearch]: {
    name: "github_issue_search",
    description: "Search a GitHub repository's issues by query and state.",
  },
  [GITHUB_TOOL_IDS.issueCreate]: {
    name: "github_issue_create",
    description: "Open a new GitHub issue, optionally with labels and assignees.",
  },
  [GITHUB_TOOL_IDS.issueComment]: {
    name: "github_issue_comment",
    description: "Post a comment on a GitHub issue.",
  },
  [GITHUB_TOOL_IDS.issueLabel]: {
    name: "github_issue_label",
    description: "Set the labels on a GitHub issue.",
  },
  [GITHUB_TOOL_IDS.issueAssign]: {
    name: "github_issue_assign",
    description: "Set the assignees on a GitHub issue.",
  },
  [GITHUB_TOOL_IDS.issueClose]: {
    name: "github_issue_close",
    description: "Close a GitHub issue, optionally with a state reason.",
  },
  [GITHUB_TOOL_IDS.pullRequestRead]: {
    name: "github_pull_request_read",
    description: "Read one GitHub pull request's title, body, state, and branches.",
  },
  [GITHUB_TOOL_IDS.pullRequestSearch]: {
    name: "github_pull_request_search",
    description: "Search a GitHub repository's pull requests by query and state.",
  },
  [GITHUB_TOOL_IDS.pullRequestCreate]: {
    name: "github_pull_request_create",
    description: "Open a new GitHub pull request from a head branch into a base branch.",
  },
  [GITHUB_TOOL_IDS.pullRequestComment]: {
    name: "github_pull_request_comment",
    description: "Post a comment on a GitHub pull request.",
  },
  [GITHUB_TOOL_IDS.pullRequestReview]: {
    name: "github_pull_request_review",
    description: "Submit a review (approve, request changes, or comment) on a GitHub pull request.",
  },
  [GITHUB_TOOL_IDS.pullRequestMerge]: {
    name: "github_pull_request_merge",
    description: "Merge a GitHub pull request.",
  },
  [GITHUB_TOOL_IDS.checkRunRead]: {
    name: "github_check_run_read",
    description: "Read one GitHub check run's status and conclusion.",
  },
  [GITHUB_TOOL_IDS.repoPush]: {
    name: "github_repo_push",
    description: "Commit one or more files to a GitHub branch.",
  },
  [GITHUB_TOOL_IDS.repositoryCreate]: {
    name: "github_repository_create",
    description:
      "Create a new GitHub repository under an org this installation covers. Requires the App's " +
      "administration:write permission, which is not granted by default — if this fails, ask an " +
      "org admin to upgrade the GitHub App's permissions from the installation's settings page.",
  },
  [GITHUB_TOOL_IDS.contentRead]: {
    name: "github_content_read",
    description: "Read a file's contents from a GitHub repository.",
  },
  [GITHUB_TOOL_IDS.contentList]: {
    name: "github_content_list",
    description: "List a directory's contents in a GitHub repository (or the repository root).",
  },
};

/** Dresses a digest as an RFC 4122 v4 uuid, same technique run-kernel uses for durable effect ids. */
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
  // The `credentialRef` names the installation covering the call's repository or account, so the
  // credential is denied for the same reason the context would be unresolvable — no installation
  // matches, or more than one does and we refuse to guess. It reaches the model first only because
  // the credential is leased before the adapter resolves scope. The remaining causes (an
  // unconfigured App, an unreadable private key) point at the same next step: the discovery tool
  // reports exactly which repositories this business can actually reach, and reports none when the
  // App itself is the problem.
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
  // Transient by definition, and the ledger has already spent this contract's retry budget on it.
  // Classifying it as infrastructure is what stops the model treating a busy provider as a
  // malformed request and rewording arguments that were never wrong.
  if (error.detail === "provider_rate_limited" || error.detail === "provider_unavailable") {
    return err("unavailable", `GitHub is temporarily unavailable; try again shortly.`);
  }
  return err("internal_error", error.detail ? `${error.code}:${error.detail}` : error.message);
}

/**
 * A rediscovered effect from an earlier attempt at this exact call (same run + call id) — the
 * ledger keeps only whether it landed, not the GitHub response body, so a replay can't hand the
 * model the original output back. Mirrors `apps/worker/src/routine/tool-port.ts`'s `replayed()`:
 * `confirmed` is success without repeating the call, anything else is a definitive negative.
 */
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

/**
 * The authorization namespace is the Tool's declared resource, not the provider's target namespace.
 *
 * `GITHUB_REPOSITORY_TARGET` and friends name targets on the *provider* side — they are what
 * `packages/integrations/src/github/adapter.ts` and the installation entitlement check compare
 * against, and they must keep their values. The authorization gate is a different namespace: a
 * grant is written against the two-level resource grammar (`integration.<slug>`, `platform.<area>`,
 * `record.<type>`), and `grantMatches` compares `resourceType` as an exact string. A derived target
 * typed `github.repository` is therefore unmatchable by any grant an operator can author, and —
 * because derived targets *replace* the Tool's static `resources` at the gate — it also stops
 * `integration.github` from being checked at all.
 *
 * So the derived type is the declared resource and the provider identity moves into the id, where
 * `recordSelector` scopes it. The kind prefix keeps a repository, an organization and the
 * installation-wide sentinel from colliding in that one id space, so a grant naming one repository
 * still cannot satisfy an installation-wide search.
 */
const GITHUB_AUTHZ_RESOURCE = "integration.github";

const repositoryRef = (id: string) => ({ type: GITHUB_AUTHZ_RESOURCE, id: `repo:${id}` });

function repositoryTargets(args: unknown): readonly ToolTargetRef[] {
  const source = recordArgs(args);
  const repository = stringValue(source, "repository");
  if (repository !== undefined) return [repositoryRef(repository)];

  const repositories = source.repositories;
  if (!Array.isArray(repositories)) return [];
  if (repositories.some((candidate) => typeof candidate !== "string")) return [];
  return repositories
    .filter((candidate): candidate is string => typeof candidate === "string")
    .map((candidate) => repositoryRef(candidate));
}

function allRepositoriesTarget(): readonly ToolTargetRef[] {
  // This is deliberately not "*": grant matching treats "*" as a grant-side wildcard sentinel.
  return [{ type: GITHUB_AUTHZ_RESOURCE, id: `installation:${GITHUB_ALL_REPOSITORIES_TARGET_ID}` }];
}

function searchRepositoryTargets(args: unknown): readonly ToolTargetRef[] {
  const source = recordArgs(args);
  const repository = stringValue(source, "repository");
  if (repository !== undefined) return [repositoryRef(repository)];

  const repositories = source.repositories;
  if (Array.isArray(repositories) && repositories.length > 0) return repositoryTargets(source);

  // Empty, absent, or wrong-typed repository selectors make the adapter search every installed
  // repository. A concrete repo grant must not satisfy that installation-wide read.
  return allRepositoriesTarget();
}

function repositoryCreateTargets(args: unknown): readonly ToolTargetRef[] {
  const owner = stringValue(recordArgs(args), "owner");
  return owner === undefined ? [] : [{ type: GITHUB_AUTHZ_RESOURCE, id: `org:${owner}` }];
}

/**
 * Which installation's credential this call needs, from the same arguments the context resolver
 * reads. Repository creation names an account (the repo does not exist yet); everything else names
 * a repository. A call that names neither — an installation-wide search — falls back to the bare
 * `any` ref, which resolves only when the business has one installation and refuses otherwise. That
 * refusal is correct: a search spanning every installed repository has no single installation whose
 * credential could honestly carry it.
 */
function githubCredentialSelector(toolId: GitHubToolId, args: unknown): GitHubInstallationSelector {
  const source = recordArgs(args);
  if (toolId === GITHUB_TOOL_IDS.repositoryCreate) {
    const owner = stringValue(source, "owner");
    return owner === undefined ? { kind: "any" } : { kind: "account", owner };
  }
  const repository = stringValue(source, "repository");
  if (repository !== undefined) return { kind: "repository", repository };

  const repositories = source.repositories;
  if (Array.isArray(repositories)) {
    const named = repositories.filter((entry): entry is string => typeof entry === "string");
    // Several repositories may still resolve to one installation, but only if they all do — the
    // first that disagrees makes the call uncarryable by any single credential.
    const first = named[0];
    if (first !== undefined && named.every((entry) => entry === first)) {
      return { kind: "repository", repository: first };
    }
  }
  return { kind: "any" };
}

function githubTargets(toolId: GitHubToolId, args: unknown): readonly ToolTargetRef[] {
  if (toolId === GITHUB_TOOL_IDS.repositoryCreate) return repositoryCreateTargets(args);
  if (toolId === GITHUB_TOOL_IDS.issueSearch || toolId === GITHUB_TOOL_IDS.pullRequestSearch) {
    return searchRepositoryTargets(args);
  }
  return repositoryTargets(args);
}

function buildToolDef(
  toolId: GitHubToolId,
  businessId: string,
  tooling: GitHubToolingContext
): ToolDef {
  const contract = GITHUB_CATALOG.get(toolId, "1.0.0");
  if (contract === undefined) {
    throw new Error(`github tool contract not published: ${toolId}`);
  }
  const spec = GITHUB_TOOL_SPECS[toolId];

  const definition = defineApiTool<RequestContext>({
    name: spec.name,
    tier: "integration",
    mutating: contract.mutating,
    description: spec.description,
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
      // Falls back to a fresh call identity when none is supplied (e.g. a direct registry test) —
      // idempotency then only holds within this one call, not across a crash/replay, which is the
      // same guarantee a non-integration ToolDef already gives.
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
        // The Tool's own declared derivation, not a second one written here: `targetsFor` is what
        // the gate reads, so building the intent from anything else would let the recorded effect
        // and the authorization decision describe different targets.
        targetRefs: definition.targetsFor(args, ctx),
        arguments: args,
        credentialRef: githubInstallationSecretRef(githubCredentialSelector(toolId, args)),
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
      });

      try {
        const output = await dispatcher.dispatch(businessId, reserved.effect.effectId);
        return ok(output);
      } catch (error) {
        if (error instanceof ToolDispatchError) return mapDispatchError(error, toolId);
        throw error;
      }
    },
  });

  return toToolDef(definition, (ctx) => ctx);
}

const EMPTY_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {},
};

export const GITHUB_REPOSITORY_LIST_TOOL_NAME = "github_repository_list";

/**
 * Local-only discovery tool: no GitHub API call, no effect ledger reservation — it just projects
 * this business's active installations. Every other GitHub tool requires an `owner/repo` argument
 * the model otherwise has no way to learn (see `context.ts`'s `integration_context_unresolved`),
 * so this is what lets the model resolve "my github issues" into a concrete repository first.
 */
function buildRepositoryListTool(tooling: GitHubTooling): ToolDef {
  const definition = defineApiTool<RequestContext>({
    name: GITHUB_REPOSITORY_LIST_TOOL_NAME,
    tier: "integration",
    mutating: false,
    description:
      "List the GitHub repositories this business has an active installation for. Call this " +
      "first when the user names no repository, or names one you're not sure is installed.",
    inputSchema: EMPTY_SCHEMA,
    authorization: {
      action: "github.repository.list",
      resources: [GITHUB_RESOURCE],
      // A catalog of which repositories are installed, not the contents of any of them.
      dataClasses: ["directory"],
      // Listing enumerates every installed repository, so require installation-wide authority.
      targets: allRepositoriesTarget,
    },
    credentialMode: "user_preferred",
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
}

export function buildGitHubTools(businessId: string, tooling: GitHubToolingContext): ToolDef[] {
  return [
    buildRepositoryListTool(tooling),
    ...GITHUB_TOOL_CONTRACTS.map((contract) =>
      buildToolDef(contract.spec.toolId as GitHubToolId, businessId, tooling)
    ),
  ];
}

/** Every chat tool name this family registers — the set excluded from a turn's allowlist while
 * GitHub is not installed (see `tools/github/visibility.ts`). Independent of any built `ToolDef[]`
 * so the exclusion can be computed without a live tooling composition. */
export const GITHUB_TOOL_NAMES: ReadonlySet<string> = new Set([
  GITHUB_REPOSITORY_LIST_TOOL_NAME,
  ...Object.values(GITHUB_TOOL_SPECS).map((spec) => spec.name),
]);
